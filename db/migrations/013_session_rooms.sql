-- Every session is a room: anyone can join a friend who's studying.
--
-- Starting a session (signed in) now joins or creates a study room straight
-- away; there's no lobby, host or start step any more, so start_room() and
-- study_rooms.started_at go unused. What's new here is that the live beat
-- (011, 012) also carries the code of the room the session is in, and
-- joinable_rooms() hands friends that code for a Join button. Joining makes
-- you friends with everyone in the room, as before.
--
-- Additive: a five-argument live_beat beside 012's four-argument one and
-- 011's one-argument one, which tabs on older code keep calling. Those two now
-- also clear the room, so a tab that drops back to one can't leave a stale
-- Join button behind. Nothing else from 012 changes.
--
-- Run before deploying the frontend that uses it, then refresh the Data API's
-- schema cache:
--   npx neonctl data-api refresh-schema --project-id silent-block-14443678 --branch main --database neondb
-- Rollback: drop live_beat(timestamptz, timestamptz, date, timestamptz, text)
-- and joinable_rooms(), recreate the other two live_beats from 012, then drop
-- live_status.room.

begin;

alter table public.live_status add column room text;

-- The new beat. All five arguments are always sent (frozen and room_code may
-- be null), so the Data API never confuses it with the older versions.
create function public.live_beat(
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
  -- Only a real room's code, so a friend's Join button can't point anywhere else.
  if v_room is not null and not exists (select 1 from public.study_rooms r where r.code = v_room) then
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

-- 012's beat, unchanged except that it clears the room.
create or replace function public.live_beat(
  studying timestamptz, frozen timestamptz, on_day date, started timestamptz)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me text := app_private.caller_id();
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
  insert into public.live_status (user_id, studying_since, last_seen, frozen_at, day, started_at, room)
  values (me, studying, now(), frozen, on_day, started, null)
  on conflict (user_id) do update
    set studying_since = excluded.studying_since, last_seen = now(),
        frozen_at = excluded.frozen_at, day = excluded.day,
        started_at = excluded.started_at, room = null;
end;
$$;

-- 011's beat (as 012 left it), unchanged except that it clears the room.
create or replace function public.live_beat(studying timestamptz)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me text := app_private.caller_id();
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
  insert into public.live_status (user_id, studying_since, last_seen, frozen_at, day, started_at, room)
  values (me, studying, now(), null, null, null, null)
  on conflict (user_id) do update
    set studying_since = excluded.studying_since, last_seen = now(),
        frozen_at = null, day = null, started_at = null, room = null;
end;
$$;

-- Friends in a session right now (a break included), with the room to join
-- them in. Rooms past their one day are left out: join_room would refuse them.
create function public.joinable_rooms()
returns table (user_id text, room_code text)
language plpgsql stable security definer set search_path = ''
as $$
declare
  me text := app_private.caller_id();
begin
  if me is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  return query
    select l.user_id, l.room
    from public.live_status l
    join public.study_rooms r on r.code = l.room
    where l.last_seen > now() - interval '90 seconds'
      and r.created_at > now() - interval '1 day'
      and exists (
        select 1 from public.friendships f
        where f.user_id = me and f.friend_id = l.user_id);
end;
$$;

revoke execute on function public.live_beat(timestamptz, timestamptz, date, timestamptz, text) from public;
revoke execute on function public.joinable_rooms()                                           from public;
grant  execute on function public.live_beat(timestamptz, timestamptz, date, timestamptz, text) to authenticated;
grant  execute on function public.joinable_rooms()                                           to authenticated;

commit;
