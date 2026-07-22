-- GM専用の性別変更アイテム。所持数・消費・魂籍の姿をサーバー台帳で一括管理する。

alter table public.gm_item_inventory
  drop constraint if exists gm_item_inventory_item_key_check;

alter table public.gm_item_inventory
  add constraint gm_item_inventory_item_key_check
  check (item_key in ('meishoku_reset', 'gender_change'));

create or replace function public.gm_gender_change_count()
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
    and i.item_key = 'gender_change';

  return coalesce(v_count, 0);
end;
$$;

create or replace function public.consume_gm_gender_change(p_gender text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_gender text := lower(btrim(coalesce(p_gender, '')));
  v_remaining integer;
begin
  if (select auth.uid()) is null or not public.is_enma_admin() then
    raise exception 'GM専用アイテムです' using errcode = '42501';
  end if;

  if v_gender not in ('m', 'f') then
    raise exception '変更先の姿を確認できません' using errcode = '22023';
  end if;

  update public.gm_item_inventory i
  set quantity = quantity - 1,
      updated_at = now()
  where i.soul_code = (
      select upper(p.soul_code)
      from public.profiles p
      where p.id = (select auth.uid())
    )
    and i.item_key = 'gender_change'
    and i.quantity > 0
  returning i.quantity into v_remaining;

  if v_remaining is null then
    raise exception '性別変更の札を持っていません' using errcode = 'P0001';
  end if;

  update public.profiles
  set avatar_key = v_gender
  where id = (select auth.uid());

  if not found then
    raise exception '魂籍の姿を更新できません' using errcode = 'P0001';
  end if;

  return v_remaining;
end;
$$;

revoke all on function public.gm_gender_change_count() from public, anon;
revoke all on function public.consume_gm_gender_change(text) from public, anon;
grant execute on function public.gm_gender_change_count() to authenticated;
grant execute on function public.consume_gm_gender_change(text) to authenticated;

notify pgrst, 'reload schema';
