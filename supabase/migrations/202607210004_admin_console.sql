-- 閻魔庁ONLINE 管理画面: 管理者権限、運営統計、メール配信設定と下書き。

create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.admin_users enable row level security;

create or replace function public.is_enma_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.admin_users a
    where a.user_id = (select auth.uid())
  );
$$;

revoke all on function public.is_enma_admin() from public, anon;
grant execute on function public.is_enma_admin() to authenticated;

drop policy if exists "admins read their own admin grant" on public.admin_users;
create policy "admins read their own admin grant"
on public.admin_users for select
to authenticated
using ((select auth.uid()) = user_id);

create table if not exists public.admin_email_settings (
  id smallint primary key default 1 check (id = 1),
  from_name text not null default '閻魔庁ONLINE'
    check (char_length(from_name) between 1 and 60),
  from_email text not null default 'noreply@notify.mkrainbowshiva.com'
    check (char_length(from_email) between 3 and 254 and position('@' in from_email) > 1),
  test_recipient text not null default 'enmacho.online@gmail.com'
    check (char_length(test_recipient) between 3 and 254 and position('@' in test_recipient) > 1),
  delivery_enabled boolean not null default false,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into public.admin_email_settings (id)
values (1)
on conflict (id) do nothing;

create table if not exists public.email_campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  subject text not null check (char_length(subject) between 1 and 120),
  body_text text not null check (char_length(body_text) between 1 and 20000),
  status text not null default 'draft'
    check (status in ('draft', 'sending', 'submitted', 'failed')),
  target_count integer not null default 0 check (target_count >= 0),
  resend_broadcast_id text,
  error_message text,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  submitted_at timestamptz
);

create index if not exists email_campaigns_created_at_idx
on public.email_campaigns (created_at desc);

drop trigger if exists admin_email_settings_touch_updated_at
on public.admin_email_settings;
create trigger admin_email_settings_touch_updated_at
before update on public.admin_email_settings
for each row execute function public.touch_updated_at();

drop trigger if exists email_campaigns_touch_updated_at
on public.email_campaigns;
create trigger email_campaigns_touch_updated_at
before update on public.email_campaigns
for each row execute function public.touch_updated_at();

alter table public.admin_email_settings enable row level security;
alter table public.email_campaigns enable row level security;

drop policy if exists "admins read email settings" on public.admin_email_settings;
create policy "admins read email settings"
on public.admin_email_settings for select
to authenticated
using ((select public.is_enma_admin()));

drop policy if exists "admins update email settings" on public.admin_email_settings;
create policy "admins update email settings"
on public.admin_email_settings for update
to authenticated
using ((select public.is_enma_admin()))
with check ((select public.is_enma_admin()));

drop policy if exists "admins read campaigns" on public.email_campaigns;
create policy "admins read campaigns"
on public.email_campaigns for select
to authenticated
using ((select public.is_enma_admin()));

drop policy if exists "admins create campaigns" on public.email_campaigns;
create policy "admins create campaigns"
on public.email_campaigns for insert
to authenticated
with check (
  (select public.is_enma_admin())
  and created_by = (select auth.uid())
);

drop policy if exists "admins update campaigns" on public.email_campaigns;
create policy "admins update campaigns"
on public.email_campaigns for update
to authenticated
using ((select public.is_enma_admin()))
with check ((select public.is_enma_admin()));

drop policy if exists "admins delete draft campaigns" on public.email_campaigns;
create policy "admins delete draft campaigns"
on public.email_campaigns for delete
to authenticated
using ((select public.is_enma_admin()) and status in ('draft', 'failed'));

grant select on public.admin_users to authenticated;
grant select, update on public.admin_email_settings to authenticated;
grant select, insert, update, delete on public.email_campaigns to authenticated;

create or replace function public.admin_dashboard_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if not public.is_enma_admin() then
    raise exception 'admin access required' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'registered', (select count(*) from public.profiles),
    'registered24h', (select count(*) from public.profiles
      where created_at >= now() - interval '24 hours'),
    'active24h', (select count(*) from public.profiles
      where last_seen_at >= now() - interval '24 hours'),
    'newsletterOptIn', (select count(*) from public.account_preferences
      where newsletter_opt_in = true),
    'cloudSaves', (select count(*) from public.game_saves),
    'acceptedFriendships', (select count(*) from public.friendships
      where status = 'accepted'),
    'draftCampaigns', (select count(*) from public.email_campaigns
      where status in ('draft', 'failed'))
  ) into result;

  return result;
end;
$$;

revoke all on function public.admin_dashboard_stats() from public, anon;
grant execute on function public.admin_dashboard_stats() to authenticated;

create or replace function public.admin_list_users(
  p_search text default '',
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  user_id uuid,
  email text,
  soul_code text,
  display_name text,
  soul_stage text,
  level integer,
  newsletter_opt_in boolean,
  created_at timestamptz,
  last_seen_at timestamptz,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_enma_admin() then
    raise exception 'admin access required' using errcode = '42501';
  end if;

  return query
  select
    p.id,
    u.email::text,
    p.soul_code,
    p.display_name,
    p.soul_stage::text,
    case
      when (s.payload ->> 'lv') ~ '^[0-9]+$'
        then greatest(1, least(999, (s.payload ->> 'lv')::integer))
      else 1
    end as level,
    coalesce(pref.newsletter_opt_in, false),
    p.created_at,
    p.last_seen_at,
    count(*) over() as total_count
  from public.profiles p
  join auth.users u on u.id = p.id
  left join public.account_preferences pref on pref.user_id = p.id
  left join public.game_saves s on s.user_id = p.id
  where btrim(coalesce(p_search, '')) = ''
    or p.display_name ilike '%' || btrim(p_search) || '%'
    or p.soul_code ilike '%' || btrim(p_search) || '%'
    or u.email ilike '%' || btrim(p_search) || '%'
  order by p.created_at desc
  limit greatest(1, least(coalesce(p_limit, 50), 100))
  offset greatest(0, coalesce(p_offset, 0));
end;
$$;

revoke all on function public.admin_list_users(text, integer, integer)
from public, anon;
grant execute on function public.admin_list_users(text, integer, integer)
to authenticated;
