-- 成立済みのフレンドへ、相手が不在でも届けられるゲーム内手紙。
create table if not exists public.soul_mail (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references auth.users(id) on delete cascade,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 240),
  created_at timestamptz not null default now(),
  read_at timestamptz,
  check (sender_id <> recipient_id)
);

create index if not exists soul_mail_recipient_time_idx
on public.soul_mail (recipient_id, created_at desc);

alter table public.soul_mail enable row level security;

drop policy if exists "recipients read their soul mail" on public.soul_mail;
create policy "recipients read their soul mail"
on public.soul_mail for select
to authenticated
using ((select auth.uid()) = recipient_id);

drop policy if exists "friends send soul mail" on public.soul_mail;
create policy "friends send soul mail"
on public.soul_mail for insert
to authenticated
with check (
  (select auth.uid()) = sender_id
  and exists (
    select 1 from public.friendships f
    where f.status = 'accepted'
      and (
        (f.requester_id = sender_id and f.addressee_id = recipient_id)
        or (f.requester_id = recipient_id and f.addressee_id = sender_id)
      )
  )
  and not exists (
    select 1 from public.blocks b
    where (b.blocker_id = sender_id and b.blocked_id = recipient_id)
       or (b.blocker_id = recipient_id and b.blocked_id = sender_id)
  )
);

drop policy if exists "recipients mark soul mail read" on public.soul_mail;
create policy "recipients mark soul mail read"
on public.soul_mail for update
to authenticated
using ((select auth.uid()) = recipient_id)
with check ((select auth.uid()) = recipient_id);

drop policy if exists "recipients delete their soul mail" on public.soul_mail;
create policy "recipients delete their soul mail"
on public.soul_mail for delete
to authenticated
using ((select auth.uid()) = recipient_id);

grant select, insert, update, delete on public.soul_mail to authenticated;
