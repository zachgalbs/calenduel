-- Group rooms: the Group tab shows each study group you're in as a shared room.
-- Everyone in it, their study time today, and who is studying right now with a
-- live timer.
--
-- Live presence: while a session runs, the timer calls heartbeat() every 15 s
-- with the session's start time, and end_live() when it stops. Someone counts
-- as studying while their last heartbeat is under 45 s old, so a closed tab
-- drops out on its own. Only the start time is shared, never the session name,
-- and only with people in a group with you.
--
-- Run this before deploying the frontend that goes with it, then refresh the
-- Data API's schema cache (re-save its settings; NOTIFY pgrst doesn't reach it).

begin;

alter table public.study_groups
  add column name text
  constraint name_length check (name is null or length(btrim(name)) between 1 and 40);

create table public.live_sessions (
  user_id    text primary key references public.profiles (user_id) on delete cascade,
  started_at timestamptz not null,
  last_seen  timestamptz not null default now()
);

-- Functions only, like the group tables.
alter table public.live_sessions enable row level security;

-- Every group the caller is in, their own first.
create function public.my_groups()
returns table (group_id uuid, name text, owner_name text, code text,
               is_owner boolean, members integer)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  me text := app_private.caller_id();
begin
  if me is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;

  return query
    select g.id,
           coalesce(g.name, p.display_name || '''s group'),
           p.display_name,
           g.code,
           g.owner_id = me,
           (select count(*)::integer from public.group_members c where c.group_id = g.id)
    from public.group_members m
    join public.study_groups g on g.id = m.group_id
    join public.profiles p on p.user_id = g.owner_id
    where m.user_id = me
    order by g.owner_id = me desc, m.joined_at;
end;
$$;

-- Everyone in a group the caller belongs to: their time on `today` (the
-- caller's local date) from finished sessions, and when their live session
-- started, if they're studying now.
create function public.group_room(target uuid, today date)
returns table (user_id text, display_name text, avatar text,
               today_ms bigint, studying_since timestamptz)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  me text := app_private.caller_id();
begin
  if me is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  if not exists (select 1 from public.group_members m
                 where m.group_id = target and m.user_id = me) then
    raise exception 'You are not in this group.' using errcode = 'P0001';
  end if;

  return query
    select p.user_id, p.display_name, p.avatar,
           coalesce((select sum(s.elapsed_ms) from public.study_sessions s
                     where s.user_id = m.user_id and s.day = today), 0)::bigint,
           (select l.started_at from public.live_sessions l
            where l.user_id = m.user_id and l.last_seen > now() - interval '45 seconds')
    from public.group_members m
    join public.profiles p on p.user_id = m.user_id
    where m.group_id = target;
end;
$$;

create function public.heartbeat(started timestamptz)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me text := app_private.caller_id();
begin
  if me is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  -- Same plausibility bounds as uploaded sessions: at most a day long, and not
  -- starting in the future beyond clock drift.
  if started > now() + interval '5 minutes' or started < now() - interval '1 day' then
    raise exception 'That session start time is not plausible.' using errcode = 'P0001';
  end if;

  insert into public.live_sessions as l (user_id, started_at, last_seen)
  values (me, started, now())
  on conflict (user_id) do update
    set started_at = excluded.started_at, last_seen = excluded.last_seen;
end;
$$;

create function public.end_live()
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me text := app_private.caller_id();
begin
  if me is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  delete from public.live_sessions l where l.user_id = me;
end;
$$;

-- The owner names the group; a blank name goes back to "<owner>'s group".
create function public.rename_group(target uuid, new_name text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me text := app_private.caller_id();
begin
  if me is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  update public.study_groups g
  set name = nullif(btrim(new_name), '')
  where g.id = target and g.owner_id = me;
  if not found then
    raise exception 'Only the person who made the group can rename it.' using errcode = 'P0001';
  end if;
end;
$$;

-- Leaving takes you out of the room. Friendships made through the group stay;
-- remove those on Compete. The owner can't leave their own group.
create function public.leave_group(target uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me text := app_private.caller_id();
begin
  if me is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  if exists (select 1 from public.study_groups g where g.id = target and g.owner_id = me) then
    raise exception 'You made this group, so you can''t leave it.' using errcode = 'P0001';
  end if;
  delete from public.group_members m where m.group_id = target and m.user_id = me;
end;
$$;

revoke execute on function public.my_groups()                 from public;
revoke execute on function public.group_room(uuid, date)      from public;
revoke execute on function public.heartbeat(timestamptz)      from public;
revoke execute on function public.end_live()                  from public;
revoke execute on function public.rename_group(uuid, text)    from public;
revoke execute on function public.leave_group(uuid)           from public;

grant execute on function public.my_groups()              to authenticated;
grant execute on function public.group_room(uuid, date)   to authenticated;
grant execute on function public.heartbeat(timestamptz)   to authenticated;
grant execute on function public.end_live()               to authenticated;
grant execute on function public.rename_group(uuid, text) to authenticated;
grant execute on function public.leave_group(uuid)        to authenticated;

commit;
