-- Two holes closed. Nothing the app calls today changes shape.
--
-- 1. The live beat took the code of any room that exists. Your friends' Join
--    button and your ?with= link both lead to the room in your beat, and
--    joining a room makes you friends with everyone in it. So someone who
--    learned another table's code could name it in their own beat, and
--    everyone following their link or Join button would be seated, and made
--    friends, with strangers at that table. The beat now keeps the code only
--    if you are a member of that room. The app already joins or creates the
--    room before it sends a beat with its code (SessionTimer sets the seat
--    after join_room or create_room returns), so nothing it does is refused.
--
-- 2. The standing groups of 008 and 009 left the app in 010, but their
--    functions kept answering. group_room() takes any date, so a group member
--    could read every other member's totals for any day: before they became
--    friends, and after being removed as one. There is no screen left to see a
--    group or leave it. Signed-in users can no longer call them. The tables
--    and functions stay, so this is undone by granting execute again.
--
-- Same signature for live_beat, so the Data API's schema cache needs no
-- refresh. Rollback: recreate live_beat (5 arguments) from 013, and grant
-- execute on the nine functions below to authenticated.

begin;

create or replace function public.live_beat(
  studying timestamptz, frozen timestamptz, on_day date, started timestamptz, room_code text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me text := app_private.caller_id();
  -- Prefixed so it can't clash with a column (study_rooms.code, live_status.room).
  v_room text := upper(trim(room_code));
begin
  if me is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  if studying is null then
    delete from public.live_status where user_id = me;
    return;
  end if;
  if studying > now() + interval '5 minutes' or studying < now() - interval '1 day' then
    raise exception 'That session start time is not plausible.' using errcode = 'P0001';
  end if;
  if frozen is not null and (frozen < studying or frozen > now() + interval '5 minutes') then
    raise exception 'That pause time is not plausible.' using errcode = 'P0001';
  end if;
  if on_day is null or on_day < current_date - 2 or on_day > current_date + 2 then
    raise exception 'That session day is not plausible.' using errcode = 'P0001';
  end if;
  if started is null or started > studying or started < now() - interval '1 day' then
    raise exception 'That session start time is not plausible.' using errcode = 'P0001';
  end if;
  -- Only a room you're sitting in, so your Join button and your link can't
  -- point at someone else's table.
  if v_room is not null and not exists (
       select 1 from public.study_rooms r
       join public.room_members m on m.room_id = r.id
       where r.code = v_room and m.user_id = me) then
    v_room := null;
  end if;
  insert into public.live_status (user_id, studying_since, last_seen, frozen_at, day, started_at, room)
  values (me, studying, now(), frozen, on_day, started, v_room)
  on conflict (user_id) do update
    set studying_since = excluded.studying_since, last_seen = now(),
        frozen_at = excluded.frozen_at, day = excluded.day,
        started_at = excluded.started_at, room = excluded.room;
end;
$$;

revoke execute on function public.my_group_code()              from authenticated;
revoke execute on function public.group_preview(text)          from authenticated;
revoke execute on function public.join_group(text)             from authenticated;
revoke execute on function public.my_groups()                  from authenticated;
revoke execute on function public.group_room(uuid, date)       from authenticated;
revoke execute on function public.rename_group(uuid, text)     from authenticated;
revoke execute on function public.leave_group(uuid)            from authenticated;
-- Presence for those groups (009); live_status replaced it in 011.
revoke execute on function public.heartbeat(timestamptz)       from authenticated;
revoke execute on function public.end_live()                   from authenticated;

commit;
