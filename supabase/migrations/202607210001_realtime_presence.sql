-- 同じマップのオンラインプレイヤー表示。
-- Presenceは在席確認、Broadcastは高頻度の位置更新に分ける。

drop policy if exists "authenticated users receive game realtime"
  on realtime.messages;
create policy "authenticated users receive game realtime"
on realtime.messages for select
to authenticated
using (
  realtime.topic() like 'game:zone:%'
  and extension in ('presence', 'broadcast')
);

drop policy if exists "authenticated users send game realtime"
  on realtime.messages;
create policy "authenticated users send game realtime"
on realtime.messages for insert
to authenticated
with check (
  realtime.topic() like 'game:zone:%'
  and extension in ('presence', 'broadcast')
);
