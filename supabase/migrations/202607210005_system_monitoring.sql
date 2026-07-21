-- 閻魔庁ONLINE システム監視: クライアント異常の安全な集約と管理画面向け照会。

create table if not exists public.system_events (
  id bigint generated always as identity primary key,
  source text not null check (source ~ '^[a-z0-9_]{1,32}$'),
  code text not null check (code ~ '^[a-z0-9_]{1,48}$'),
  severity text not null default 'warning'
    check (severity in ('info', 'warning', 'error', 'critical')),
  message text not null check (char_length(message) between 1 and 160),
  details jsonb not null default '{}'::jsonb
    check (jsonb_typeof(details) = 'object' and octet_length(details::text) <= 4000),
  user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists system_events_created_at_idx
on public.system_events (created_at desc);

create index if not exists system_events_dedupe_idx
on public.system_events (user_id, source, code, created_at desc);

alter table public.system_events enable row level security;

drop policy if exists "admins read system events" on public.system_events;
create policy "admins read system events"
on public.system_events for select
to authenticated
using ((select public.is_enma_admin()));

create or replace function public.report_client_event(
  p_source text,
  p_code text,
  p_severity text default 'warning',
  p_message text default '',
  p_details jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  clean_source text := lower(btrim(coalesce(p_source, '')));
  clean_code text := lower(btrim(coalesce(p_code, '')));
  clean_severity text := lower(btrim(coalesce(p_severity, 'warning')));
  clean_message text := left(btrim(coalesce(p_message, '')), 160);
  clean_details jsonb := coalesce(p_details, '{}'::jsonb);
begin
  if current_user_id is null then
    return false;
  end if;
  if clean_source !~ '^[a-z0-9_]{1,32}$'
    or clean_code !~ '^[a-z0-9_]{1,48}$'
    or clean_severity not in ('info', 'warning', 'error', 'critical')
    or jsonb_typeof(clean_details) <> 'object'
    or octet_length(clean_details::text) > 4000 then
    return false;
  end if;
  if clean_message = '' then clean_message := clean_code; end if;

  -- 同じ利用者・同じ異常は2分に1件、全体でも10分に30件までに抑える。
  if exists (
    select 1 from public.system_events e
    where e.user_id = current_user_id
      and e.source = clean_source and e.code = clean_code
      and e.created_at >= now() - interval '2 minutes'
  ) or (
    select count(*) from public.system_events e
    where e.user_id = current_user_id
      and e.created_at >= now() - interval '10 minutes'
  ) >= 30 then
    return false;
  end if;

  insert into public.system_events
    (source, code, severity, message, details, user_id)
  values
    (clean_source, clean_code, clean_severity, clean_message, clean_details, current_user_id);

  delete from public.system_events
  where created_at < now() - interval '30 days';
  return true;
end;
$$;

revoke all on function public.report_client_event(text, text, text, text, jsonb)
from public, anon;
grant execute on function public.report_client_event(text, text, text, text, jsonb)
to authenticated;

create or replace function public.admin_system_health(p_hours integer default 24)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  hours integer := greatest(1, least(coalesce(p_hours, 24), 168));
  result jsonb;
begin
  if not public.is_enma_admin() then
    raise exception 'admin access required' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'events1h', count(*) filter (where created_at >= now() - interval '1 hour'),
    'events24h', count(*) filter (where created_at >= now() - (hours || ' hours')::interval),
    'warnings24h', count(*) filter (where severity = 'warning'
      and created_at >= now() - (hours || ' hours')::interval),
    'errors24h', count(*) filter (where severity in ('error', 'critical')
      and created_at >= now() - (hours || ' hours')::interval),
    'affectedUsers24h', count(distinct user_id) filter (
      where created_at >= now() - (hours || ' hours')::interval),
    'lastEventAt', max(created_at),
    'lastWorldEventAt', max(created_at) filter (where source = 'world')
  ) into result
  from public.system_events;
  return result;
end;
$$;

revoke all on function public.admin_system_health(integer) from public, anon;
grant execute on function public.admin_system_health(integer) to authenticated;

create or replace function public.admin_list_system_events(p_limit integer default 50)
returns table (
  id bigint,
  source text,
  code text,
  severity text,
  message text,
  details jsonb,
  user_id uuid,
  display_name text,
  soul_code text,
  created_at timestamptz
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
  select e.id, e.source, e.code, e.severity, e.message, e.details,
    e.user_id, p.display_name, p.soul_code, e.created_at
  from public.system_events e
  left join public.profiles p on p.id = e.user_id
  order by e.created_at desc
  limit greatest(1, least(coalesce(p_limit, 50), 100));
end;
$$;

revoke all on function public.admin_list_system_events(integer) from public, anon;
grant execute on function public.admin_list_system_events(integer) to authenticated;
