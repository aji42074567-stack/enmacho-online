-- GM専用「神足の御符」。在庫は通常セーブから分離し、GM本人だけが確認・消費できる。

alter table public.gm_item_inventory
  drop constraint if exists gm_item_inventory_item_key_check;

alter table public.gm_item_inventory
  add constraint gm_item_inventory_item_key_check
  check (item_key in ('meishoku_reset', 'gender_change', 'gm_dash'));

create or replace function public.gm_dash_count()
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
    and i.item_key = 'gm_dash';

  return coalesce(v_count, 0);
end;
$$;

create or replace function public.consume_gm_dash()
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
    and i.item_key = 'gm_dash'
    and i.quantity > 0
  returning i.quantity into v_remaining;

  if v_remaining is null then
    raise exception '神足の御符を持っていません' using errcode = 'P0001';
  end if;

  return v_remaining;
end;
$$;

revoke all on function public.gm_dash_count() from public, anon;
revoke all on function public.consume_gm_dash() from public, anon;
grant execute on function public.gm_dash_count() to authenticated;
grant execute on function public.consume_gm_dash() to authenticated;

notify pgrst, 'reload schema';
