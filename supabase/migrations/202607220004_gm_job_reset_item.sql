-- GM専用の冥職やり直しアイテム。所持数と消費はクライアントセーブと分けて管理する。

create table if not exists public.gm_item_inventory (
  soul_code text not null check (soul_code ~ '^KON-[0-9A-F]{8}$'),
  item_key text not null check (item_key in ('meishoku_reset')),
  quantity integer not null default 0 check (quantity between 0 and 999),
  updated_at timestamptz not null default now(),
  primary key (soul_code, item_key)
);

alter table public.gm_item_inventory enable row level security;

-- テスト担当GM「あじ」の魂籍だけに30個付与する。
insert into public.gm_item_inventory (soul_code, item_key, quantity)
values ('KON-1BA90A84', 'meishoku_reset', 30)
on conflict (soul_code, item_key)
do update set quantity = excluded.quantity, updated_at = now();

-- テーブルを直接更新させず、GM権限を確認するRPCだけを公開する。
revoke all on table public.gm_item_inventory from public, anon, authenticated;

create or replace function public.gm_meishoku_reset_count()
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
begin
  if (select auth.uid()) is null or not public.is_enma_admin() then
    return 0;
  end if;

  select i.quantity
  into v_count
  from public.gm_item_inventory i
  join public.profiles p on upper(p.soul_code) = i.soul_code
  where p.id = (select auth.uid())
    and i.item_key = 'meishoku_reset';

  return coalesce(v_count, 0);
end;
$$;

create or replace function public.consume_gm_meishoku_reset()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_remaining integer;
begin
  if (select auth.uid()) is null or not public.is_enma_admin() then
    raise exception 'GM専用アイテムです' using errcode = '42501';
  end if;

  update public.gm_item_inventory i
  set quantity = quantity - 1,
      updated_at = now()
  where i.soul_code = (
      select upper(p.soul_code)
      from public.profiles p
      where p.id = (select auth.uid())
    )
    and i.item_key = 'meishoku_reset'
    and i.quantity > 0
  returning i.quantity into v_remaining;

  if v_remaining is null then
    raise exception '冥職やり直しの札を持っていません'
      using errcode = 'P0001';
  end if;

  return v_remaining;
end;
$$;

revoke all on function public.gm_meishoku_reset_count() from public, anon;
revoke all on function public.consume_gm_meishoku_reset() from public, anon;
grant execute on function public.gm_meishoku_reset_count() to authenticated;
grant execute on function public.consume_gm_meishoku_reset() to authenticated;
