alter table public.profiles
add column if not exists level integer not null default 1
  check (level between 1 and 999);

-- 既存の魂籍はクラウド記録から現在の徳位を復元する。
update public.profiles as profile
set level = greatest(1, least(999,
  case
    when save.payload ->> 'lv' ~ '^[0-9]{1,3}$' then (save.payload ->> 'lv')::integer
    else 1
  end
))
from public.game_saves as save
where profile.id = save.user_id;

create or replace function public.sync_profile_level_from_save()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles
  set level = greatest(1, least(999,
    case
      when new.payload ->> 'lv' ~ '^[0-9]{1,3}$' then (new.payload ->> 'lv')::integer
      else 1
    end
  ))
  where id = new.user_id;
  return new;
end;
$$;

drop trigger if exists game_saves_sync_profile_level on public.game_saves;
create trigger game_saves_sync_profile_level
after insert or update of payload on public.game_saves
for each row execute function public.sync_profile_level_from_save();

revoke all on function public.sync_profile_level_from_save()
  from public, anon, authenticated;
