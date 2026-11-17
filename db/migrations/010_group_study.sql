-- Group study: a study session people do together, live. The host starts one
-- from Compete and shares its link; people join a lobby and see each other
-- arrive; the host starts it, and everyone clicks Start studying. While it runs,
-- each person sees who's studying and for how long.
--
-- A room is short-lived: it can be joined for 24 hours after it's made. Joining
-- also makes you friends with everyone in the room, so the group shows up on
-- Compete afterwards without anyone swapping codes.
--
-- Presence: every open lobby or session sends room_beat() every few seconds,
-- with the start time of its running session (or null). Someone counts as here
-- while their last beat is under 90 s old: generous, because browsers slow
-- timers in background tabs, and a study tab usually is one. When a session
-- stops (a beat with null) or its tab disappears, its time is banked into
-- studied_ms. Only start times and durations are shared, never session names.
--
-- Replaces the standing groups of 008/009 in the app; those tables are no
-- longer used by the frontend.
--
-- Run before deploying the frontend that uses it, then refresh the Data API's
-- schema cache (re-save its settings; NOTIFY pgrst doesn't reach it).

begin;

create table public.study_rooms (
  id         uuid primary key default gen_random_uuid(),
  -- 40 random bits. The link is the invitation, and rooms expire after a day.
  code       text not null unique
             default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)),
  host_id    text not null references public.profiles (user_id) on delete cascade,
  created_at timestamptz not null default now(),
  started_at timestamptz
);

create table public.room_members (
  room_id        uuid not null references public.study_rooms (id) on delete cascade,
  user_id        text not null references public.profiles (user_id) on delete cascade,
  joined_at      timestamptz not null default now(),
  last_seen      timestamptz not null default now(),
  studying_since timestamptz,
  studied_ms     bigint not null default 0 check (studied_ms between 0 and 86400000),
  primary key (room_id, user_id)
);

create index room_members_user on public.room_members (user_id);

-- Functions only.
alter table public.study_rooms  enable row level security;
alter table public.room_members enable row level security;

-- The time from a member's open stretch that hasn't been banked yet: up to now
-- while they're here, up to their last beat once they've gone quiet.
create function app_private.open_ms(m public.room_members)
returns bigint
language sql stable set search_path = ''
as $$
  select case when m.studying_since is null then 0
    else greatest(0, (extract(epoch from (
      least(now(), m.last_seen + interval '15 seconds') - m.studying_since)) * 1000)::bigint)
  end
$$;

create function public.create_room()
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  me text := app_private.caller_id();
  r public.study_rooms;
begin
  if me is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  insert into public.study_rooms (host_id) values (me) returning * into r;
  insert into public.room_members (room_id, user_id) values (r.id, me);
  return r.code;
end;
$$;

-- What a link leads to, before joining.
create function public.room_preview(room_code text)
returns table (host_name text, members integer, started boolean, joined boolean, expired boolean)
language plpgsql stable security definer set search_path = ''
as $$
declare
  me text := app_private.caller_id();
begin
  if me is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  return query
    select p.display_name,
           (select count(*)::integer from public.room_members m where m.room_id = r.id),
           r.started_at is not null,
           exists (select 1 from public.room_members m where m.room_id = r.id and m.user_id = me),
           r.created_at < now() - interval '1 day'
    from public.study_rooms r
    join public.profiles p on p.user_id = r.host_id
    where r.code = upper(trim(room_code));
end;
$$;

-- Joins, and connects the caller with everyone in the room both ways. Returns
-- how many new friends that made.
create function public.join_room(room_code text)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  me text := app_private.caller_id();
  r public.study_rooms;
  added integer;
begin
  if me is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  select * into r from public.study_rooms sr where sr.code = upper(trim(room_code));
  if not found then
    raise exception 'That group study link does not match any group study.' using errcode = 'P0001';
  end if;
  if r.created_at < now() - interval '1 day' then
    raise exception 'That group study has ended. Ask for a new link.' using errcode = 'P0001';
  end if;

  insert into public.room_members (room_id, user_id) values (r.id, me)
  on conflict (room_id, user_id) do update set last_seen = now();

  with others as (
    select m.user_id from public.room_members m
    where m.room_id = r.id and m.user_id <> me
  ), made as (
    insert into public.friendships (user_id, friend_id)
    select me, o.user_id from others o
    union all
    select o.user_id, me from others o
    on conflict do nothing
    returning friendships.user_id
  )
  select count(*)::integer into added from made where made.user_id = me;
  return added;
end;
$$;

-- Everyone in the room. banked_ms is time already done; live_since is the
-- start of a session running right now, for a ticking timer.
create function public.room_state(room_code text)
returns table (user_id text, display_name text, avatar text, is_host boolean,
               here boolean, live_since timestamptz, banked_ms bigint,
               host_name text, started_at timestamptz)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  me text := app_private.caller_id();
  r public.study_rooms;
begin
  if me is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  select * into r from public.study_rooms sr where sr.code = upper(trim(room_code));
  if not found or not exists (select 1 from public.room_members m
                              where m.room_id = r.id and m.user_id = me) then
    raise exception 'You are not in this group study.' using errcode = 'P0001';
  end if;

  return query
    select p.user_id, p.display_name, p.avatar,
           m.user_id = r.host_id,
           m.last_seen > now() - interval '90 seconds',
           case when m.last_seen > now() - interval '90 seconds' then m.studying_since end,
           least(86400000, m.studied_ms + case
             when m.last_seen > now() - interval '90 seconds' then 0
             else app_private.open_ms(m) end),
           hp.display_name,
           r.started_at
    from public.room_members m
    join public.profiles p on p.user_id = m.user_id
    join public.profiles hp on hp.user_id = r.host_id
    where m.room_id = r.id
    order by m.joined_at;
end;
$$;

create function public.start_room(room_code text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me text := app_private.caller_id();
begin
  if me is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  update public.study_rooms r set started_at = coalesce(r.started_at, now())
  where r.code = upper(trim(room_code)) and r.host_id = me;
  if not found then
    raise exception 'Only the host can start the group study.' using errcode = 'P0001';
  end if;
end;
$$;

-- "I'm here", with the start of my running session or null. A change of
-- session (stopped, or a new one) banks the previous one first.
create function public.room_beat(room_code text, studying timestamptz)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me text := app_private.caller_id();
  m public.room_members;
begin
  if me is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  if studying is not null
     and (studying > now() + interval '5 minutes' or studying < now() - interval '1 day') then
    raise exception 'That session start time is not plausible.' using errcode = 'P0001';
  end if;

  select rm.* into m
  from public.room_members rm
  join public.study_rooms r on r.id = rm.room_id
  where r.code = upper(trim(room_code)) and rm.user_id = me
  for update of rm;
  if not found then
    raise exception 'You are not in this group study.' using errcode = 'P0001';
  end if;

  update public.room_members rm
  set studied_ms = case
        when m.studying_since is not distinct from studying then rm.studied_ms
        else least(86400000, rm.studied_ms + app_private.open_ms(m)) end,
      studying_since = studying,
      last_seen = now()
  where rm.room_id = m.room_id and rm.user_id = me;
end;
$$;

-- Leaving banks any running session and takes you out of the room.
create function public.leave_room(room_code text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me text := app_private.caller_id();
begin
  if me is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  delete from public.room_members rm
  using public.study_rooms r
  where r.id = rm.room_id and r.code = upper(trim(room_code)) and rm.user_id = me;
end;
$$;

revoke execute on function app_private.open_ms(public.room_members) from public;
revoke execute on function public.create_room()                   from public;
revoke execute on function public.room_preview(text)              from public;
revoke execute on function public.join_room(text)                 from public;
revoke execute on function public.room_state(text)                from public;
revoke execute on function public.start_room(text)                from public;
revoke execute on function public.room_beat(text, timestamptz)    from public;
revoke execute on function public.leave_room(text)                from public;

grant execute on function public.create_room()                to authenticated;
grant execute on function public.room_preview(text)           to authenticated;
grant execute on function public.join_room(text)              to authenticated;
grant execute on function public.room_state(text)             to authenticated;
grant execute on function public.start_room(text)             to authenticated;
grant execute on function public.room_beat(text, timestamptz) to authenticated;
grant execute on function public.leave_room(text)             to authenticated;

commit;
