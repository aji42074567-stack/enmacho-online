-- 閻魔庁ONLINE専用の送信ドメインへ切り替える。

alter table public.admin_email_settings
  alter column from_email set default 'noreply@notify.enmacho.com';

update public.admin_email_settings
set from_email = 'noreply@notify.enmacho.com',
    updated_at = now()
where id = 1
  and from_email = 'noreply@notify.mkrainbowshiva.com';
