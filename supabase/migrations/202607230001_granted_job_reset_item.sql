-- 運営から個別付与された冥職やり直しの札を、受取人本人が利用できるようにする。
-- 在庫テーブルは引き続き非公開とし、RPCはログイン中の魂籍だけを参照・更新する。

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
  if (select auth.uid()) is null then
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
  if (select auth.uid()) is null then
    raise exception '魂籍へログインしてください' using errcode = '42501';
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
