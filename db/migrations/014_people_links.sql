-- Usernames, a permanent link per person, guests, and rooms that last only
-- while someone's in them.
--
-- Usernames: profiles.display_name becomes the username: unique, 3-20 of
-- a-z 0-9 _, and yours to change (set_username). It starts as a slug of your
-- Google name ("Zachary Galbraith" -> zacharygalbraith, then zacharygalbraith2
-- if that's taken) and is no longer overwritten from Google on every sign-in.
-- Everything that already shows display_name shows the username unchanged.
--
-- Links: timelapse.study/?with=<username> is how you invite someone, and it
-- never expires. person_peek() says what it leads to: who that is and, while
-- they're in a session, the room they're studying in and who's at its table.
-- Room codes are internal now; they no longer appear in links.
--
-- Guests: someone signed out can follow a link, press Enter, and sit at the
-- table as "Guest". A guest has no profile, so they live in their own table,
-- keyed by a random secret their browser makes and keeps. Guests make no
-- friendships and bank no time: their session stays on their device until
-- they sign in.
--
-- Rooms disband: leaving (now done on Stop, so the others see you go instead
-- of a dark lamp; a break keeps you seated) deletes the room once nobody's
-- left in it. A room whose last tab just closed is swept by the next
-- create_room(). Here means a beat in the last 90 s.
--
-- The anonymous role (Data API requests with Neon Auth's anonymous token)
-- reaches only person_peek, room_peek and the three guest functions.
--
-- Run before deploying the frontend that uses it, then refresh the Data API's
-- schema cache (re-save its settings in the Neon console).
-- Rollback: drop the new functions, public.room_guests, the profiles
-- constraints below; restore ensure_profile, create_room and leave_room from
-- 004 and 010. Usernames stay as slugs.

begin;

-- ── Usernames ──────────────────────────────────────────────────────────────

-- A name made fit for a username, before checking it's free.
create function app_private.username_from(name text)
returns text
language sql immutable set search_path = ''
as $$
  select case when length(s) >= 3 then s else 'studier' end
  from (select left(regexp_replace(lower(coalesce(name, '')), '[^a-z0-9_]', '', 'g'), 20) as s) x
$$;

-- base, or base with the smallest number after it that nobody else has.
create function app_private.free_username(base text, owner text)
returns text
language plpgsql stable set search_path = ''
as $$
declare
  candidate text := base;
  n integer := 1;
begin
  while exists (select 1 from public.profiles p
                where p.display_name = candidate and p.user_id <> owner) loop
    n := n + 1;
    candidate := left(base, 20 - length(n::text)) || n;
  end loop;
  return candidate;
end;
$$;

revoke execute on function app_private.username_from(text)      from public;
revoke execute on function app_private.free_username(text, text) from public;

-- Existing names become usernames, oldest first, so the first to sign up
-- keeps the plain one.
do $$
declare
  p record;
begin
  for p in select user_id, display_name from public.profiles order by created_at, user_id loop
    update public.profiles
    set display_name = app_private.free_username(app_private.username_from(p.display_name), p.user_id)
    where user_id = p.user_id;
  end loop;
end;
$$;

alter table public.profiles
  add constraint profiles_username_format check (display_name ~ '^[a-z0-9_]{3,20}$'),
  add constraint profiles_username_unique unique (display_name);

-- As 004's, except a new profile's name is a free username, and an existing
-- one's is left alone: it's the user's to change now, not Google's.
create or replace function public.ensure_profile()
returns table (user_id text, display_name text, invite_code text, avatar text)
language plpgsql security definer set search_path = ''
as $$
declare
  me text := app_private.caller_id();
begin
  if me is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;

  if not exists (select 1 from public.profiles p where p.user_id = me) then
    insert into public.profiles as p (user_id, display_name)
    select me, app_private.free_username(app_private.username_from(u.name), me)
    from neon_auth."user" u
    where u.id::text = me
    on conflict on constraint profiles_pkey do nothing;
  end if;

  return query
    select p.user_id, p.display_name, p.invite_code, p.avatar
    from public.profiles p
    where p.user_id = me;
end;
$$;

-- Sets the caller's username. Returns it as stored (lowercase).
create function public.set_username(username text)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  me text := app_private.caller_id();
  wanted text := lower(trim(both from ltrim(trim(username), '@')));
begin
  if me is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  if wanted !~ '^[a-z0-9_]{3,20}$' then
    raise exception 'A username is 3 to 20 letters, numbers or underscores.' using errcode = 'P0001';
  end if;
  begin
    update public.profiles p set display_name = wanted where p.user_id = me;
  exception when unique_violation then
    raise exception 'That username is taken.' using errcode = 'P0001';
  end;
  return wanted;
end;
$$;

-- ── Guests ─────────────────────────────────────────────────────────────────

create table public.room_guests (
  room_id        uuid not null references public.study_rooms (id) on delete cascade,
  -- Shown to others. The secret never leaves the guest's browser and this table.
  id             uuid not null default gen_random_uuid(),
  secret         uuid not null,
  joined_at      timestamptz not null default now(),
  last_seen      timestamptz not null default now(),
  studying_since timestamptz,
  primary key (room_id, id),
  unique (room_id, secret)
);

-- Functions only.
alter table public.room_guests enable row level security;

-- ── Who's at a table ───────────────────────────────────────────────────────

-- Everyone here now, in the order they came; live = their lamp is lit.
create function app_private.room_people(room uuid)
returns jsonb
language sql stable set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'avatar', x.avatar,
                                               'live', x.live) order by x.joined_at), '[]'::jsonb)
  from (
    select m.user_id as id, p.display_name as name, p.avatar,
           m.studying_since is not null as live, m.joined_at
    from public.room_members m
    join public.profiles p on p.user_id = m.user_id
    where m.room_id = room and m.last_seen > now() - interval '90 seconds'
    union all
    select 'guest:' || g.id, 'Guest', null, g.studying_since is not null, g.joined_at
    from public.room_guests g
    where g.room_id = room and g.last_seen > now() - interval '90 seconds'
  ) x
$$;

-- Whether the caller (signed in, or the guest holding guest_secret) is here.
create function app_private.in_room(room uuid, guest_secret uuid)
returns boolean
language sql stable set search_path = ''
as $$
  select exists (select 1 from public.room_members m
                 where m.room_id = room and m.user_id = app_private.caller_id()
                   and m.last_seen > now() - interval '90 seconds')
      or exists (select 1 from public.room_guests g
                 where g.room_id = room and g.secret = guest_secret
                   and g.last_seen > now() - interval '90 seconds')
$$;

-- Deletes a room nobody is in any more.
create function app_private.disband_if_empty(room uuid)
returns void
language sql volatile set search_path = ''
as $$
  delete from public.study_rooms r
  where r.id = room
    and not exists (select 1 from public.room_members m
                    where m.room_id = r.id and m.last_seen > now() - interval '90 seconds')
    and not exists (select 1 from public.room_guests g
                    where g.room_id = r.id and g.last_seen > now() - interval '90 seconds')
$$;

revoke execute on function app_private.room_people(uuid)          from public;
revoke execute on function app_private.in_room(uuid, uuid)        from public;
revoke execute on function app_private.disband_if_empty(uuid)     from public;

-- The table of a room you're in, by its code; null once it's gone.
create function public.room_peek(room_code text, guest_secret uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  r public.study_rooms;
begin
  select * into r from public.study_rooms sr where sr.code = upper(trim(room_code));
  if not found then
    return null;
  end if;
  return jsonb_build_object('people', app_private.room_people(r.id));
end;
$$;

-- What a ?with=<username> link leads to, or null if nobody has that name.
-- room is the code of the room they're studying in (a break included), null
-- when they're not in a session; joined says you're at that table already.
create function public.person_peek(username text, guest_secret uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  p public.profiles;
  r public.study_rooms;
begin
  select * into p from public.profiles pr where pr.display_name = lower(trim(username));
  if not found then
    return null;
  end if;
  select sr.* into r
  from public.live_status l
  join public.study_rooms sr on sr.code = l.room
  where l.user_id = p.user_id
    and l.last_seen > now() - interval '90 seconds'
    and sr.created_at > now() - interval '1 day';
  return jsonb_build_object(
    'name', p.display_name,
    'avatar', p.avatar,
    'is_me', coalesce(p.user_id = app_private.caller_id(), false),
    'room', r.code,
    'joined', case when r.id is null then false else app_private.in_room(r.id, guest_secret) end,
    'people', case when r.id is null then '[]'::jsonb else app_private.room_people(r.id) end);
end;
$$;

-- ── Guest seats ────────────────────────────────────────────────────────────

-- Sits a guest at the table. Returns the id others see them by.
create function public.guest_join(room_code text, guest_secret uuid)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  r public.study_rooms;
  gid uuid;
begin
  if guest_secret is null then
    raise exception 'A guest needs a secret.' using errcode = 'P0001';
  end if;
  select * into r from public.study_rooms sr where sr.code = upper(trim(room_code));
  if not found or r.created_at < now() - interval '1 day' then
    raise exception 'That study room has ended.' using errcode = 'P0001';
  end if;
  -- Enough for any real table; stops a stranger with the link filling it.
  if (select count(*) from public.room_guests g
      where g.room_id = r.id and g.secret <> guest_secret) >= 20 then
    raise exception 'That study room is full.' using errcode = 'P0001';
  end if;

  insert into public.room_guests (room_id, secret) values (r.id, guest_secret)
  on conflict (room_id, secret) do update set last_seen = now()
  returning id into gid;
  return 'guest:' || gid;
end;
$$;

-- A guest's "I'm here", with the start of their running stretch or null.
create function public.guest_beat(room_code text, guest_secret uuid, studying timestamptz)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if studying is not null
     and (studying > now() + interval '5 minutes' or studying < now() - interval '1 day') then
    raise exception 'That session start time is not plausible.' using errcode = 'P0001';
  end if;
  update public.room_guests g
  set studying_since = studying, last_seen = now()
  from public.study_rooms r
  where r.id = g.room_id and r.code = upper(trim(room_code)) and g.secret = guest_secret;
  if not found then
    raise exception 'You are not in this study room.' using errcode = 'P0001';
  end if;
end;
$$;

create function public.guest_leave(room_code text, guest_secret uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  room uuid;
begin
  delete from public.room_guests g
  using public.study_rooms r
  where r.id = g.room_id and r.code = upper(trim(room_code)) and g.secret = guest_secret
  returning g.room_id into room;
  if room is not null then
    perform app_private.disband_if_empty(room);
  end if;
end;
$$;

-- ── Rooms that disband ─────────────────────────────────────────────────────

-- As 010's, and first sweeps rooms left empty by tabs that closed without
-- leaving (a couple of minutes' grace, so a room just made is never swept).
create or replace function public.create_room()
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
  delete from public.study_rooms sr
  where sr.created_at < now() - interval '2 minutes'
    and not exists (select 1 from public.room_members m
                    where m.room_id = sr.id and m.last_seen > now() - interval '90 seconds')
    and not exists (select 1 from public.room_guests g
                    where g.room_id = sr.id and g.last_seen > now() - interval '90 seconds');
  insert into public.study_rooms (host_id) values (me) returning * into r;
  insert into public.room_members (room_id, user_id) values (r.id, me);
  return r.code;
end;
$$;

-- As 010's, and the last one out disbands the room.
create or replace function public.leave_room(room_code text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me text := app_private.caller_id();
  room uuid;
begin
  if me is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  delete from public.room_members rm
  using public.study_rooms r
  where r.id = rm.room_id and r.code = upper(trim(room_code)) and rm.user_id = me
  returning rm.room_id into room;
  if room is not null then
    perform app_private.disband_if_empty(room);
  end if;
end;
$$;

-- ── Grants ─────────────────────────────────────────────────────────────────

revoke execute on function public.set_username(text)                  from public;
revoke execute on function public.room_peek(text, uuid)               from public;
revoke execute on function public.person_peek(text, uuid)             from public;
revoke execute on function public.guest_join(text, uuid)              from public;
revoke execute on function public.guest_beat(text, uuid, timestamptz) from public;
revoke execute on function public.guest_leave(text, uuid)             from public;

grant execute on function public.set_username(text)                  to authenticated;
grant execute on function public.room_peek(text, uuid)               to anonymous, authenticated;
grant execute on function public.person_peek(text, uuid)             to anonymous, authenticated;
grant execute on function public.guest_join(text, uuid)              to anonymous;
grant execute on function public.guest_beat(text, uuid, timestamptz) to anonymous;
grant execute on function public.guest_leave(text, uuid)             to anonymous;

commit;
