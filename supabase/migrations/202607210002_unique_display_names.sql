-- 魂名は大小文字と前後空白を無視して一意にする。
-- 既存の重複は、最初の登録を残し、2件目以降へ魂籍番号由来の接尾辞を付ける。

update public.profiles
set display_name = btrim(display_name)
where display_name <> btrim(display_name);

with ranked as (
  select
    id,
    row_number() over (
      partition by lower(btrim(display_name))
      order by created_at, id
    ) as duplicate_number
  from public.profiles
), duplicates as (
  select p.id,
    left(p.display_name, 7) || '_' || replace(p.soul_code, 'KON-', '') as unique_name
  from public.profiles p
  join ranked r on r.id = p.id
  where r.duplicate_number > 1
)
update public.profiles p
set display_name = d.unique_name
from duplicates d
where p.id = d.id;

alter table public.profiles
drop constraint if exists profiles_display_name_trimmed;

alter table public.profiles
add constraint profiles_display_name_trimmed
check (display_name = btrim(display_name));

create unique index if not exists profiles_display_name_unique
on public.profiles (lower(btrim(display_name)));

create or replace function public.is_display_name_available(p_display_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    char_length(btrim(coalesce(p_display_name, ''))) between 1 and 16
    and not exists (
      select 1
      from public.profiles p
      where lower(btrim(p.display_name)) = lower(btrim(p_display_name))
    );
$$;

revoke all on function public.is_display_name_available(text)
from public;
grant execute on function public.is_display_name_available(text)
to anon, authenticated;
