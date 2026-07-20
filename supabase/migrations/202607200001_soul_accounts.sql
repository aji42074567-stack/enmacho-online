create extension if not exists pgcrypto;

do $$
begin
  create type public.soul_stage as enum ('deceased', 'rebirth_candidate', 'reincarnated');
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type public.friendship_status as enum ('pending', 'accepted', 'declined');
exception
  when duplicate_object then null;
end $$;

create or replace function public.new_soul_code()
returns text
language sql
volatile
set search_path = ''
as $$
  select 'KON-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
$$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  soul_code text not null unique default public.new_soul_code(),
  display_name text not null default 'ナナシ'
    check (char_length(display_name) between 1 and 16),
  soul_stage public.soul_stage not null default 'deceased',
  avatar_key text not null default 'm' check (avatar_key in ('m', 'f')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table if not exists public.account_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  newsletter_opt_in boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists public.game_saves (
  user_id uuid primary key references auth.users(id) on delete cascade,
  save_version integer not null default 1 check (save_version > 0),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  revision bigint not null default 1 check (revision > 0),
  client_updated_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.blocks (
  blocker_id uuid not null references auth.users(id) on delete cascade,
  blocked_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

create table if not exists public.friendships (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references auth.users(id) on delete cascade,
  addressee_id uuid not null references auth.users(id) on delete cascade,
  status public.friendship_status not null default 'pending',
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  check (requester_id <> addressee_id)
);

create unique index if not exists friendships_pair_unique
on public.friendships (
  least(requester_id, addressee_id),
  greatest(requester_id, addressee_id)
);

create table if not exists public.nearby_chat_messages (
  id bigint generated always as identity primary key,
  sender_id uuid not null references auth.users(id) on delete cascade,
  zone_id text not null check (char_length(zone_id) between 1 and 32),
  position_x real not null,
  position_y real not null,
  body text not null check (char_length(body) between 1 and 50),
  created_at timestamptz not null default now()
);

create index if not exists nearby_chat_zone_time_idx
on public.nearby_chat_messages (zone_id, created_at desc);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
before update on public.profiles
for each row execute function public.touch_updated_at();

drop trigger if exists account_preferences_touch_updated_at on public.account_preferences;
create trigger account_preferences_touch_updated_at
before update on public.account_preferences
for each row execute function public.touch_updated_at();

drop trigger if exists game_saves_touch_updated_at on public.game_saves;
create trigger game_saves_touch_updated_at
before update on public.game_saves
for each row execute function public.touch_updated_at();

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested_name text;
  requested_newsletter boolean;
begin
  requested_name := left(
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), 'ナナシ'),
    16
  );
  requested_newsletter := case
    when new.raw_user_meta_data ->> 'newsletter_opt_in' in ('true', 'false')
      then (new.raw_user_meta_data ->> 'newsletter_opt_in')::boolean
    else false
  end;

  insert into public.profiles (id, display_name)
  values (new.id, requested_name)
  on conflict (id) do nothing;
  insert into public.account_preferences (user_id, newsletter_opt_in)
  values (new.id, requested_newsletter)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_auth_user();

insert into public.profiles (id, display_name)
select
  u.id,
  left(coalesce(nullif(trim(u.raw_user_meta_data ->> 'display_name'), ''), 'ナナシ'), 16)
from auth.users u
on conflict (id) do nothing;

insert into public.account_preferences (user_id, newsletter_opt_in)
select
  u.id,
  case
    when u.raw_user_meta_data ->> 'newsletter_opt_in' in ('true', 'false')
      then (u.raw_user_meta_data ->> 'newsletter_opt_in')::boolean
    else false
  end
from auth.users u
on conflict (user_id) do nothing;

alter table public.profiles enable row level security;
alter table public.account_preferences enable row level security;
alter table public.game_saves enable row level security;
alter table public.friendships enable row level security;
alter table public.blocks enable row level security;
alter table public.nearby_chat_messages enable row level security;

drop policy if exists "authenticated profiles are visible" on public.profiles;
create policy "authenticated profiles are visible"
on public.profiles for select
to authenticated
using (true);

drop policy if exists "users update their own profile" on public.profiles;
create policy "users update their own profile"
on public.profiles for update
to authenticated
using ((select auth.uid()) = id)
with check ((select auth.uid()) = id);

drop policy if exists "users read their own account preferences" on public.account_preferences;
create policy "users read their own account preferences"
on public.account_preferences for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "users update their own account preferences" on public.account_preferences;
create policy "users update their own account preferences"
on public.account_preferences for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "users read their own save" on public.game_saves;
create policy "users read their own save"
on public.game_saves for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "users insert their own save" on public.game_saves;
create policy "users insert their own save"
on public.game_saves for insert
to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "users update their own save" on public.game_saves;
create policy "users update their own save"
on public.game_saves for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "participants read friendships" on public.friendships;
create policy "participants read friendships"
on public.friendships for select
to authenticated
using ((select auth.uid()) in (requester_id, addressee_id));

drop policy if exists "users send friend requests" on public.friendships;
create policy "users send friend requests"
on public.friendships for insert
to authenticated
with check (
  (select auth.uid()) = requester_id
  and status = 'pending'
  and not exists (
    select 1 from public.blocks b
    where (b.blocker_id = requester_id and b.blocked_id = addressee_id)
       or (b.blocker_id = addressee_id and b.blocked_id = requester_id)
  )
);

drop policy if exists "addressees answer friend requests" on public.friendships;
create policy "addressees answer friend requests"
on public.friendships for update
to authenticated
using ((select auth.uid()) = addressee_id and status = 'pending')
with check ((select auth.uid()) = addressee_id and status in ('accepted', 'declined'));

drop policy if exists "participants delete friendships" on public.friendships;
create policy "participants delete friendships"
on public.friendships for delete
to authenticated
using ((select auth.uid()) in (requester_id, addressee_id));

drop policy if exists "users read their own blocks" on public.blocks;
create policy "users read their own blocks"
on public.blocks for select
to authenticated
using ((select auth.uid()) = blocker_id);

drop policy if exists "users create their own blocks" on public.blocks;
create policy "users create their own blocks"
on public.blocks for insert
to authenticated
with check ((select auth.uid()) = blocker_id);

drop policy if exists "users remove their own blocks" on public.blocks;
create policy "users remove their own blocks"
on public.blocks for delete
to authenticated
using ((select auth.uid()) = blocker_id);

drop policy if exists "authenticated users read unblocked nearby chat" on public.nearby_chat_messages;
create policy "authenticated users read unblocked nearby chat"
on public.nearby_chat_messages for select
to authenticated
using (
  not exists (
    select 1 from public.blocks b
    where (b.blocker_id = (select auth.uid()) and b.blocked_id = sender_id)
       or (b.blocker_id = sender_id and b.blocked_id = (select auth.uid()))
  )
);

create or replace function public.send_nearby_chat(
  p_zone_id text,
  p_position_x real,
  p_position_y real,
  p_body text
)
returns public.nearby_chat_messages
language plpgsql
security definer
set search_path = ''
as $$
declare
  clean_body text := trim(p_body);
  new_message public.nearby_chat_messages;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  if char_length(p_zone_id) not between 1 and 32 then
    raise exception 'invalid zone';
  end if;
  if char_length(clean_body) not between 1 and 50 then
    raise exception 'message must be 1 to 50 characters';
  end if;
  if exists (
    select 1 from public.nearby_chat_messages m
    where m.sender_id = auth.uid()
      and m.created_at > now() - interval '1 second'
  ) then
    raise exception 'please wait before sending again';
  end if;
  if (
    select count(*) from public.nearby_chat_messages m
    where m.sender_id = auth.uid()
      and m.created_at > now() - interval '1 minute'
  ) >= 20 then
    raise exception 'message rate limit exceeded';
  end if;

  insert into public.nearby_chat_messages
    (sender_id, zone_id, position_x, position_y, body)
  values
    (auth.uid(), p_zone_id, p_position_x, p_position_y, clean_body)
  returning * into new_message;

  return new_message;
end;
$$;

create or replace function public.delete_expired_nearby_chat()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_count bigint;
begin
  delete from public.nearby_chat_messages
  where created_at < now() - interval '7 days';
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

grant usage on schema public to authenticated;
grant select on public.profiles to authenticated;
grant update (display_name, soul_stage, avatar_key, last_seen_at)
  on public.profiles to authenticated;
grant select on public.account_preferences to authenticated;
grant update (newsletter_opt_in) on public.account_preferences to authenticated;
grant select, insert, update on public.game_saves to authenticated;
grant select, insert, update, delete on public.friendships to authenticated;
grant select, insert, delete on public.blocks to authenticated;
grant select on public.nearby_chat_messages to authenticated;
revoke all on function public.send_nearby_chat(text, real, real, text)
  from public, anon, authenticated;
grant execute on function public.send_nearby_chat(text, real, real, text) to authenticated;
revoke all on function public.delete_expired_nearby_chat()
  from public, anon, authenticated;
grant execute on function public.delete_expired_nearby_chat() to service_role;
