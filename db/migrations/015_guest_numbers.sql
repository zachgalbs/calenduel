-- Guests are guest1, guest2, ... instead of all being "Guest": each takes
-- the smallest number nobody else at that table has, and keeps it.
--
-- Rollback: restore room_people and guest_join from 014, then drop
-- room_guests.number.

begin;

alter table public.room_guests add column number integer not null default 1;

create or replace function app_private.room_people(room uuid)
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
    select 'guest:' || g.id, 'guest' || g.number, null, g.studying_since is not null, g.joined_at
    from public.room_guests g
    where g.room_id = room and g.last_seen > now() - interval '90 seconds'
  ) x
$$;

create or replace function public.guest_join(room_code text, guest_secret uuid)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  r public.study_rooms;
  gid uuid;
  n integer;
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

  select min(s.n) into n
  from generate_series(1, 21) s(n)
  where not exists (select 1 from public.room_guests g
                    where g.room_id = r.id and g.number = s.n and g.secret <> guest_secret);

  insert into public.room_guests (room_id, secret, number) values (r.id, guest_secret, n)
  on conflict (room_id, secret) do update set last_seen = now()
  returning id into gid;
  return 'guest:' || gid;
end;
$$;

commit;
