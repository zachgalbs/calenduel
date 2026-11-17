-- Live status: a green dot on Compete next to anyone in a study session now.
--
-- While a session runs, the timer sends live_beat() with the session's start
-- time every 30 s; stopping sends null. Someone counts as studying while their
-- last beat is under 90 s old, so a closed tab or a crash clears the dot by
-- itself. Only you and your friends can see it, and only "studying or not":
-- studying_now() returns ids, never start times or session names.
--
-- Run before deploying the frontend that uses it, then refresh the Data API's
-- schema cache:
--   npx neonctl data-api refresh-schema --project-id silent-block-14443678 --branch main --database neondb
-- Rollback: drop the two functions and the table (see the vault's rollbacks/).

begin;

create table public.live_status (
  user_id        text primary key references public.profiles (user_id) on delete cascade,
  studying_since timestamptz not null,
  last_seen      timestamptz not null default now()
);

-- Functions only.
alter table public.live_status enable row level security;

create function public.live_beat(studying timestamptz)
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
  insert into public.live_status (user_id, studying_since, last_seen)
  values (me, studying, now())
  on conflict (user_id) do update
    set studying_since = excluded.studying_since, last_seen = now();
end;
$$;

-- You and your friends who are studying right now.
create function public.studying_now()
returns table (user_id text)
language plpgsql stable security definer set search_path = ''
as $$
declare
  me text := app_private.caller_id();
begin
  if me is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  return query
    select l.user_id
    from public.live_status l
    where l.last_seen > now() - interval '90 seconds'
      and (l.user_id = me or exists (
        select 1 from public.friendships f
        where f.user_id = me and f.friend_id = l.user_id));
end;
$$;

revoke execute on function public.live_beat(timestamptz) from public;
revoke execute on function public.studying_now()         from public;
grant  execute on function public.live_beat(timestamptz) to authenticated;
grant  execute on function public.studying_now()         to authenticated;

commit;
