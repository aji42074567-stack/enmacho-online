-- 閻魔庁ONLINE 講(ギルド): 亡者たちの相互扶助の結社。
-- 設立(講元)はゴウリュウを鎮めた者のみ。入講は誰でも可。1人1講まで。
-- 書き込みはすべて security definer のRPC経由。テーブル直接の変更権限は渡さない。

create table if not exists public.guilds (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (char_length(name) between 2 and 12),
  master_id uuid not null references auth.users(id) on delete cascade,
  motto text not null default '' check (char_length(motto) <= 60),
  created_at timestamptz not null default now()
);

create table if not exists public.guild_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  guild_id uuid not null references public.guilds(id) on delete cascade,
  role text not null default 'member' check (role in ('master', 'officer', 'member')),
  joined_at timestamptz not null default now()
);

create index if not exists guild_members_guild_idx
on public.guild_members (guild_id, joined_at);

alter table public.guilds enable row level security;
alter table public.guild_members enable row level security;

-- 講名・名簿は公開情報(【講名】表示や勧誘のため)
drop policy if exists "authenticated read guilds" on public.guilds;
create policy "authenticated read guilds"
on public.guilds for select
to authenticated
using (true);

drop policy if exists "authenticated read guild members" on public.guild_members;
create policy "authenticated read guild members"
on public.guild_members for select
to authenticated
using (true);

grant select on public.guilds to authenticated;
grant select on public.guild_members to authenticated;

-- 講の定員
create or replace function public.guild_member_limit()
returns integer
language sql
immutable
as $$ select 20 $$;

-- 講を立てる: ゴウリュウ討伐(クラウド記録)が条件
create or replace function public.create_guild(p_name text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_name text := btrim(coalesce(p_name, ''));
  v_guild_id uuid;
begin
  if v_uid is null then
    raise exception '魂籍ログインが必要です';
  end if;
  if char_length(v_name) < 2 or char_length(v_name) > 12 then
    raise exception '講名は2〜12文字で入力してください';
  end if;
  if exists (select 1 from public.guild_members m where m.user_id = v_uid) then
    raise exception 'すでに講に所属しています。講は一人一つまでです';
  end if;
  if not exists (
    select 1 from public.game_saves s
    where s.user_id = v_uid
      and (
        (s.payload -> 'story' ->> 'dragonCleared') = 'true'
        or coalesce((s.payload ->> 'drakeKilledAt')::numeric, 0) > 0
      )
  ) then
    raise exception '結社願を受理できるのは、ゴウリュウを鎮めてクラウドに記録を残した者だけです';
  end if;

  begin
    insert into public.guilds (name, master_id)
    values (v_name, v_uid)
    returning id into v_guild_id;
  exception when unique_violation then
    raise exception 'その講名はすでに使われています。別の名を選んでください';
  end;

  insert into public.guild_members (user_id, guild_id, role)
  values (v_uid, v_guild_id, 'master');

  return jsonb_build_object('id', v_guild_id, 'name', v_name);
end;
$$;

-- 講に入る(勧誘の検証はゲーム側。定員と重複所属はここで守る)
create or replace function public.join_guild(p_guild_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception '魂籍ログインが必要です';
  end if;
  if exists (select 1 from public.guild_members m where m.user_id = v_uid) then
    raise exception 'すでに講に所属しています。移るには先に脱退してください';
  end if;
  if not exists (select 1 from public.guilds g where g.id = p_guild_id) then
    raise exception 'その講は見つかりません(解散した可能性があります)';
  end if;
  if (select count(*) from public.guild_members m where m.guild_id = p_guild_id)
    >= public.guild_member_limit() then
    raise exception 'その講は定員(%人)に達しています', public.guild_member_limit();
  end if;
  insert into public.guild_members (user_id, guild_id, role)
  values (v_uid, p_guild_id, 'member');
end;
$$;

-- 講を抜ける。講元が抜けたら世話役→古参の順に講元を継承。誰もいなければ講は消滅
create or replace function public.leave_guild()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_guild_id uuid;
  v_role text;
  v_next uuid;
begin
  select m.guild_id, m.role into v_guild_id, v_role
  from public.guild_members m where m.user_id = v_uid;
  if v_guild_id is null then
    raise exception '講に所属していません';
  end if;

  delete from public.guild_members m where m.user_id = v_uid;

  if v_role = 'master' then
    select m.user_id into v_next
    from public.guild_members m
    where m.guild_id = v_guild_id
    order by (m.role = 'officer') desc, m.joined_at asc
    limit 1;
    if v_next is null then
      delete from public.guilds g where g.id = v_guild_id;
    else
      update public.guild_members m set role = 'master' where m.user_id = v_next;
      update public.guilds g set master_id = v_next where g.id = v_guild_id;
    end if;
  end if;
end;
$$;

-- 講元による解散
create or replace function public.disband_guild()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_guild_id uuid;
begin
  select g.id into v_guild_id
  from public.guilds g
  join public.guild_members m on m.guild_id = g.id and m.user_id = v_uid
  where m.role = 'master';
  if v_guild_id is null then
    raise exception '講元だけが講を解散できます';
  end if;
  delete from public.guilds g where g.id = v_guild_id;
end;
$$;

-- 破門(講元は誰でも、世話役は講員のみ)
create or replace function public.kick_guild_member(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_guild_id uuid;
  v_role text;
  v_target_role text;
begin
  select m.guild_id, m.role into v_guild_id, v_role
  from public.guild_members m where m.user_id = v_uid;
  if v_guild_id is null or v_role not in ('master', 'officer') then
    raise exception '破門できるのは講元と世話役だけです';
  end if;
  if p_user_id = v_uid then
    raise exception '自分は破門できません。「脱退」を使ってください';
  end if;
  select m.role into v_target_role
  from public.guild_members m
  where m.user_id = p_user_id and m.guild_id = v_guild_id;
  if v_target_role is null then
    raise exception 'その魂は同じ講にいません';
  end if;
  if v_role = 'officer' and v_target_role <> 'member' then
    raise exception '世話役が破門できるのは講員だけです';
  end if;
  delete from public.guild_members m where m.user_id = p_user_id;
end;
$$;

-- 役職の変更(講元のみ。世話役⇔講員)
create or replace function public.set_guild_role(p_user_id uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_guild_id uuid;
begin
  if p_role not in ('officer', 'member') then
    raise exception '指定できる役職は世話役か講員です';
  end if;
  select m.guild_id into v_guild_id
  from public.guild_members m
  where m.user_id = v_uid and m.role = 'master';
  if v_guild_id is null then
    raise exception '役職を変えられるのは講元だけです';
  end if;
  if p_user_id = v_uid then
    raise exception '講元自身の役職は変えられません';
  end if;
  update public.guild_members m set role = p_role
  where m.user_id = p_user_id and m.guild_id = v_guild_id;
  if not found then
    raise exception 'その魂は同じ講にいません';
  end if;
end;
$$;

-- 講の情報(指定なしなら自分の講)。名簿は魂名つき
create or replace function public.get_guild_info(p_guild_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_guild_id uuid := p_guild_id;
  result jsonb;
begin
  if v_uid is null then
    raise exception '魂籍ログインが必要です';
  end if;
  if v_guild_id is null then
    select m.guild_id into v_guild_id
    from public.guild_members m where m.user_id = v_uid;
  end if;
  if v_guild_id is null then
    return null;
  end if;

  select jsonb_build_object(
    'id', g.id,
    'name', g.name,
    'motto', g.motto,
    'masterId', g.master_id,
    'createdAt', g.created_at,
    'memberLimit', public.guild_member_limit(),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
        'userId', m.user_id,
        'name', coalesce(p.display_name, 'ナナシ'),
        'role', m.role,
        'joinedAt', m.joined_at
      ) order by (m.role = 'master') desc, (m.role = 'officer') desc, m.joined_at asc)
      from public.guild_members m
      left join public.profiles p on p.id = m.user_id
      where m.guild_id = g.id
    ), '[]'::jsonb)
  ) into result
  from public.guilds g
  where g.id = v_guild_id;

  return result;
end;
$$;

revoke all on function public.create_guild(text) from public, anon;
revoke all on function public.join_guild(uuid) from public, anon;
revoke all on function public.leave_guild() from public, anon;
revoke all on function public.disband_guild() from public, anon;
revoke all on function public.kick_guild_member(uuid) from public, anon;
revoke all on function public.set_guild_role(uuid, text) from public, anon;
revoke all on function public.get_guild_info(uuid) from public, anon;
grant execute on function public.create_guild(text) to authenticated;
grant execute on function public.join_guild(uuid) to authenticated;
grant execute on function public.leave_guild() to authenticated;
grant execute on function public.disband_guild() to authenticated;
grant execute on function public.kick_guild_member(uuid) to authenticated;
grant execute on function public.set_guild_role(uuid, text) to authenticated;
grant execute on function public.get_guild_info(uuid) to authenticated;
