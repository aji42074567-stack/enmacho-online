-- 閻魔庁ONLINE 目安箱: ゲーム内の意見・要望の投書と、開発者からのお礼返信。

create table if not exists public.feedback_box (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  soul_name text not null default '' check (char_length(soul_name) <= 16),
  body text not null check (char_length(body) between 1 and 500),
  status text not null default 'new' check (status in ('new', 'replied', 'archived')),
  reply_body text check (reply_body is null or char_length(reply_body) between 1 and 500),
  replied_by uuid references auth.users(id) on delete set null,
  replied_at timestamptz,
  reply_read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists feedback_box_created_idx
on public.feedback_box (created_at desc);

create index if not exists feedback_box_user_idx
on public.feedback_box (user_id, created_at desc);

alter table public.feedback_box enable row level security;

-- 本人: 投書を入れる
drop policy if exists "players submit feedback" on public.feedback_box;
create policy "players submit feedback"
on public.feedback_box for insert
to authenticated
with check ((select auth.uid()) = user_id);

-- 本人: 自分の投書と返礼を読む
drop policy if exists "players read own feedback" on public.feedback_box;
create policy "players read own feedback"
on public.feedback_box for select
to authenticated
using ((select auth.uid()) = user_id);

-- 本人: 返礼の既読だけ更新できる(更新できる列はgrantで制限)
drop policy if exists "players mark reply read" on public.feedback_box;
create policy "players mark reply read"
on public.feedback_box for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

grant select on public.feedback_box to authenticated;
grant insert (user_id, soul_name, body) on public.feedback_box to authenticated;
grant update (reply_read_at) on public.feedback_box to authenticated;

-- 管理者: 投書一覧(登録情報を添えて返す)
create or replace function public.admin_list_feedback(
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  id uuid,
  user_id uuid,
  soul_name text,
  display_name text,
  soul_code text,
  body text,
  status text,
  reply_body text,
  replied_at timestamptz,
  reply_read_at timestamptz,
  created_at timestamptz,
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
    f.id,
    f.user_id,
    f.soul_name,
    coalesce(p.display_name, ''),
    coalesce(p.soul_code, ''),
    f.body,
    f.status,
    f.reply_body,
    f.replied_at,
    f.reply_read_at,
    f.created_at,
    count(*) over() as total_count
  from public.feedback_box f
  left join public.profiles p on p.id = f.user_id
  order by f.created_at desc
  limit greatest(1, least(coalesce(p_limit, 50), 200))
  offset greatest(0, coalesce(p_offset, 0));
end;
$$;

revoke all on function public.admin_list_feedback(integer, integer) from public, anon;
grant execute on function public.admin_list_feedback(integer, integer) to authenticated;

-- 管理者: お礼(返礼)を書く。書き直すと未読へ戻る
create or replace function public.admin_reply_feedback(
  p_id uuid,
  p_body text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_enma_admin() then
    raise exception 'admin access required' using errcode = '42501';
  end if;
  if btrim(coalesce(p_body, '')) = '' or char_length(btrim(p_body)) > 500 then
    raise exception 'お礼の本文は1〜500文字で入力してください';
  end if;

  update public.feedback_box
  set reply_body = btrim(p_body),
      replied_by = (select auth.uid()),
      replied_at = now(),
      reply_read_at = null,
      status = 'replied'
  where id = p_id;

  if not found then
    raise exception '対象の投書が見つかりません';
  end if;
end;
$$;

revoke all on function public.admin_reply_feedback(uuid, text) from public, anon;
grant execute on function public.admin_reply_feedback(uuid, text) to authenticated;

-- 運営統計へ「未対応の投書」を追加
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
      where status in ('draft', 'failed')),
    'feedbackNew', (select count(*) from public.feedback_box
      where status = 'new')
  ) into result;

  return result;
end;
$$;

revoke all on function public.admin_dashboard_stats() from public, anon;
grant execute on function public.admin_dashboard_stats() to authenticated;
