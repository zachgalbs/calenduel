-- Live time: a running session counts toward Compete while it runs, not only
-- once it's stopped and uploaded.
--
-- live_status (011) only said "studying or not". Each beat now also says how
-- far the session has got and which day it will be filed under:
--   studying: the session's start pushed later by its finished breaks, so that
--             (now - studying) is the time studied so far.
--   frozen:   when the clock stopped (a break, or Stop while the upload is on
--             its way); null while studying. Time studied = frozen - studying.
--   on_day:   the day the upload will count toward (its start, in the
--             studier's own timezone), so the live time lands on the same day.
--   started:  the session's real start, which its upload also carries. Once
--             that upload exists, live_times stops returning the row, so the
--             session is never counted twice, whatever order things land in.
-- live_times() returns that to you and your friends. That shares how long your
-- current session has run, as group study already does with its members. The
-- green dot (studying_now) still means "studying right now": not on a break.
--
-- Backward compatible: a tab still running the old code keeps calling the
-- one-argument live_beat and studying_now, unchanged for it. Its rows carry
-- no day: live_times returns them for the dot, and the app counts no time for
-- them (the old code counts breaks in `studying`, so it would be wrong).
--
-- Run before deploying the frontend that uses it, then refresh the Data API's
-- schema cache:
--   npx neonctl data-api refresh-schema --project-id silent-block-14443678 --branch main --database neondb
-- Rollback: the vault's rollbacks/012_rollback.sql.

begin;

alter table public.live_status
  add column frozen_at  timestamptz,
  add column day        date,
  add column started_at timestamptz;

-- The old code's beat. Same signature; it now clears the new columns.
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
  insert into public.live_status (user_id, studying_since, last_seen, frozen_at, day, started_at)
  values (me, studying, now(), null, null, null)
  on conflict (user_id) do update
    set studying_since = excluded.studying_since, last_seen = now(),
        frozen_at = null, day = null, started_at = null;
end;
$$;

-- The new beat. All four arguments are always sent (frozen may be null), so
-- the Data API never confuses it with the one-argument version.
create function public.live_beat(
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
  insert into public.live_status (user_id, studying_since, last_seen, frozen_at, day, started_at)
  values (me, studying, now(), frozen, on_day, started)
  on conflict (user_id) do update
    set studying_since = excluded.studying_since, last_seen = now(),
        frozen_at = excluded.frozen_at, day = excluded.day, started_at = excluded.started_at;
end;
$$;

-- The green dot: studying right now, so not on a break.
create or replace function public.studying_now()
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
      and l.frozen_at is null
      and (l.user_id = me or exists (
        select 1 from public.friendships f
        where f.user_id = me and f.friend_id = l.user_id));
end;
$$;

-- You and your friends in a session right now, with how far it has got. A
-- session that has already uploaded is left out: its time is in the totals.
create function public.live_times()
returns table (user_id text, studying_since timestamptz, frozen_at timestamptz, day date)
language plpgsql stable security definer set search_path = ''
as $$
declare
  me text := app_private.caller_id();
begin
  if me is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  return query
    select l.user_id, l.studying_since, l.frozen_at, l.day
    from public.live_status l
    where l.last_seen > now() - interval '90 seconds'
      and (l.user_id = me or exists (
        select 1 from public.friendships f
        where f.user_id = me and f.friend_id = l.user_id))
      and not exists (
        select 1 from public.study_sessions s
        where s.user_id = l.user_id and s.started_at = l.started_at);
end;
$$;

revoke execute on function public.live_beat(timestamptz, timestamptz, date, timestamptz) from public;
revoke execute on function public.live_times()                             from public;
grant  execute on function public.live_beat(timestamptz, timestamptz, date, timestamptz) to authenticated;
grant  execute on function public.live_times()                             to authenticated;

commit;
