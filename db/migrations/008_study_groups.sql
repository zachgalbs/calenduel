-- Study groups: one link that connects a whole group, instead of everyone
-- swapping invite codes with everyone else (10 swaps for 5 people).
--
-- Each person has at most one group link. Opening someone's link and clicking
-- Join makes you friends with everyone already in that group, and later joiners
-- become friends with you the same way. A group is nothing more than that list
-- of people; friendships stay the ordinary one-to-one kind, so removing a friend
-- works as before (it doesn't take you out of the group, and nobody is
-- re-added until someone joins again).
--
-- Like an invite code, the link is the secret: anyone holding it can join and
-- see the members' sessions, so share it only with the group.
--
-- The tables have RLS on and no grants: the app only reaches them through the
-- functions below, which run as the owner and check the caller themselves.
--
-- Run this before deploying the frontend that goes with it. The old frontend
-- never touches these tables, so that order is safe.

begin;

create table public.study_groups (
  id         uuid primary key default gen_random_uuid(),
  -- 48 random bits, like an invite code.
  code       text not null unique
             default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)),
  -- Unique: one group link per person.
  owner_id   text not null unique references public.profiles (user_id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.group_members (
  group_id  uuid not null references public.study_groups (id) on delete cascade,
  user_id   text not null references public.profiles (user_id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

create index group_members_user on public.group_members (user_id);

alter table public.study_groups  enable row level security;
alter table public.group_members enable row level security;

-- The caller's own group link code, creating the group (with them in it) the
-- first time.
create function public.my_group_code()
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  me text := app_private.caller_id();
  g public.study_groups;
begin
  if me is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;

  insert into public.study_groups (owner_id) values (me)
  on conflict (owner_id) do nothing;
  select * into g from public.study_groups sg where sg.owner_id = me;
  insert into public.group_members (group_id, user_id) values (g.id, me)
  on conflict do nothing;
  return g.code;
end;
$$;

-- Whose group a link is for and how many are in it, so the join button can say
-- what it does before anyone clicks it. Reveals nothing a link holder couldn't
-- learn by joining.
create function public.group_preview(group_code text)
returns table (owner_name text, members integer, joined boolean)
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
           (select count(*)::integer from public.group_members m where m.group_id = g.id),
           exists (select 1 from public.group_members m
                   where m.group_id = g.id and m.user_id = me)
    from public.study_groups g
    join public.profiles p on p.user_id = g.owner_id
    where g.code = upper(trim(group_code));
end;
$$;

-- Joins the group and connects the caller with every other member, both ways.
-- Returns how many new friends that made (0 if they already were).
create function public.join_group(group_code text)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  me text := app_private.caller_id();
  g public.study_groups;
  added integer;
begin
  if me is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;

  select * into g from public.study_groups sg where sg.code = upper(trim(group_code));
  if not found then
    raise exception 'That group link does not match any group.' using errcode = 'P0001';
  end if;

  insert into public.group_members (group_id, user_id) values (g.id, me)
  on conflict do nothing;

  with others as (
    select m.user_id from public.group_members m
    where m.group_id = g.id and m.user_id <> me
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

revoke execute on function public.my_group_code()       from public;
revoke execute on function public.group_preview(text)   from public;
revoke execute on function public.join_group(text)      from public;

grant execute on function public.my_group_code()     to authenticated;
grant execute on function public.group_preview(text) to authenticated;
grant execute on function public.join_group(text)    to authenticated;

commit;

-- The Data API caches the schema; without this it answers "Could not find the
-- function" until it happens to reload.
notify pgrst, 'reload schema';
