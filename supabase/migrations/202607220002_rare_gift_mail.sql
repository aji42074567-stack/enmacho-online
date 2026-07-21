-- フレンドへの手紙に、レア装備または消耗品を1個添付する。
-- 受取処理はRPCで行い、同じ添付品を二重に受け取れないよう行ロックする。

alter table public.soul_mail
  add column if not exists attachment_kind text,
  add column if not exists attachment_id text,
  add column if not exists attachment_name text,
  add column if not exists attachment_claimed_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'soul_mail_attachment_complete'
  ) then
    alter table public.soul_mail add constraint soul_mail_attachment_complete check (
      (attachment_kind is null and attachment_id is null and attachment_name is null)
      or (
        attachment_kind is not null and attachment_id is not null and attachment_name is not null
        and char_length(attachment_name) between 1 and 40
      )
    );
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'soul_mail_attachment_allowed'
  ) then
    alter table public.soul_mail add constraint soul_mail_attachment_allowed check (
      attachment_kind is null
      or (
        attachment_kind = 'equipment'
        and attachment_id in (
          'drake_slayer','rokumon_black','kurogane_babi','shunawa_kote','gokusotsu','kusarifuji',
          'kuchinuno_mask','kuchinuno_kote','kawa_boots','kifuda_gofu','fuju_eboshi',
          'jukotsu_crown','jukotsu_kote','saso_tabi','setsuju_boots',
          'kagenui','gaimen_hood','kagegoku_ninja','kagegoku_kote','kagegoku_tabi',
          'shion_mofuku','shion_kote','shion_tabi','higan_shuin','higan_tekko','hakkin_gusoku',
          'sogetsu_kabuto','seirin_musha','kurogane_tsutsugote','seirin_gusoku','kiyome_bukuro'
        )
      )
      or (
        attachment_kind in ('heal_s','heal_m','heal_l','haste','crit','wscroll','ascroll','dragon_blood')
        and attachment_id = attachment_kind
      )
    );
  end if;
end;
$$;

create or replace function public.claim_soul_mail_attachment(p_mail_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_kind text;
  v_id text;
  v_name text;
begin
  if v_uid is null then
    raise exception '魂籍ログインが必要です';
  end if;

  select m.attachment_kind, m.attachment_id, m.attachment_name
    into v_kind, v_id, v_name
  from public.soul_mail m
  where m.id = p_mail_id
    and m.recipient_id = v_uid
    and m.attachment_kind is not null
    and m.attachment_claimed_at is null
  for update;

  if not found then
    if exists (
      select 1 from public.soul_mail m
      where m.id = p_mail_id and m.recipient_id = v_uid and m.attachment_claimed_at is not null
    ) then
      raise exception 'この添付品は受取済みです';
    end if;
    raise exception '受け取れる添付品がありません';
  end if;

  update public.soul_mail
  set attachment_claimed_at = now(), read_at = coalesce(read_at, now())
  where id = p_mail_id and recipient_id = v_uid;

  return jsonb_build_object('kind', v_kind, 'id', v_id, 'name', v_name);
end;
$$;

revoke all on function public.claim_soul_mail_attachment(uuid) from public;
grant execute on function public.claim_soul_mail_attachment(uuid) to authenticated;

notify pgrst, 'reload schema';
