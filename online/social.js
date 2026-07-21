const SOCIAL_POLL_MS = 30_000;
const VALID_ID = /^[0-9a-f-]{16,64}$/i;
const GIFT_KINDS = new Set([
  'equipment', 'heal_s', 'heal_m', 'heal_l', 'haste', 'crit',
  'wscroll', 'ascroll', 'dragon_blood',
]);

const cleanId = value => String(value || '').trim().slice(0, 64);
const cleanName = value => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 16) || 'ナナシ';
function cleanGift(raw) {
  if (!raw) return null;
  const kind = String(raw.kind || '').trim();
  const id = String(raw.id || '').trim().slice(0, 64);
  const name = String(raw.name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!GIFT_KINDS.has(kind) || !id || !name) throw new Error('添付する品を確認できません');
  return { kind, id, name };
}

export function createSocialController(client, bridge = window.EnmaGameBridge) {
  let session = null;
  let friendships = [];
  let pollTimer = 0;
  let refreshRevision = 0;

  const userId = () => session?.user?.id || '';

  function clearPoll() {
    if (pollTimer) window.clearInterval(pollTimer);
    pollTimer = 0;
  }

  function emptyState(error = '') {
    bridge?.syncSocialState?.({
      online: false,
      friends: [],
      incoming: [],
      outgoing: [],
      mail: [],
      error,
    });
  }

  async function profileMap(ids) {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return new Map();
    const { data, error } = await client
      .from('profiles')
      .select('id,display_name')
      .in('id', unique);
    if (error) throw error;
    return new Map((data || []).map(profile => [profile.id, cleanName(profile.display_name)]));
  }

  async function refresh() {
    const ownId = userId();
    const revision = ++refreshRevision;
    if (!ownId) {
      friendships = [];
      emptyState();
      return null;
    }

    try {
      const friendshipResult = await client
        .from('friendships')
        .select('id,requester_id,addressee_id,status,created_at,responded_at')
        .order('created_at', { ascending: false });
      if (friendshipResult.error) throw friendshipResult.error;
      if (revision !== refreshRevision || ownId !== userId()) return null;
      friendships = friendshipResult.data || [];

      const mailResult = await client
        .from('soul_mail')
        .select('id,sender_id,recipient_id,body,created_at,read_at,attachment_kind,attachment_id,attachment_name,attachment_claimed_at')
        .eq('recipient_id', ownId)
        .order('created_at', { ascending: false })
        .limit(50);
      const mail = mailResult.error ? [] : (mailResult.data || []);

      // 目安箱への開発者返礼も「手紙」として合流させる(RLSで自分の投書だけ返る)
      const feedbackResult = await client
        .from('feedback_box')
        .select('id,body,reply_body,replied_at,reply_read_at')
        .not('reply_body', 'is', null)
        .order('replied_at', { ascending: false })
        .limit(20);
      const devReplies = feedbackResult.error ? [] : (feedbackResult.data || []);

      const peerIds = friendships.map(row => (
        row.requester_id === ownId ? row.addressee_id : row.requester_id
      ));
      const profiles = await profileMap([...peerIds, ...mail.map(row => row.sender_id)]);
      if (revision !== refreshRevision || ownId !== userId()) return null;

      const friends = [];
      const incoming = [];
      const outgoing = [];
      for (const row of friendships) {
        const peerId = row.requester_id === ownId ? row.addressee_id : row.requester_id;
        const peer = {
          id: peerId,
          friendshipId: row.id,
          name: profiles.get(peerId) || 'ナナシ',
          at: Date.parse(row.responded_at || row.created_at) || Date.now(),
          cloud: true,
        };
        if (row.status === 'accepted') friends.push(peer);
        else if (row.status === 'pending' && row.addressee_id === ownId) incoming.push(peer);
        else if (row.status === 'pending') outgoing.push(peer);
      }

      const mailItems = [
        ...mail.map(row => ({
          id: row.id,
          senderId: row.sender_id,
          senderName: profiles.get(row.sender_id) || 'ナナシ',
          body: String(row.body || '').slice(0, 240),
          createdAt: row.created_at,
          readAt: row.read_at,
          gift: row.attachment_kind ? {
            kind: row.attachment_kind,
            id: row.attachment_id,
            name: String(row.attachment_name || '添付品').slice(0, 40),
            claimedAt: row.attachment_claimed_at,
          } : null,
        })),
        ...devReplies.map(row => ({
          id: `fb-${row.id}`,
          senderId: '',
          senderName: '閻魔庁',
          body: `${String(row.reply_body || '').slice(0, 500)}\n――目安箱への投書「${
            String(row.body || '').replace(/\s+/g, ' ').slice(0, 24)}${
            String(row.body || '').length > 24 ? '…' : ''}」への返礼`,
          createdAt: row.replied_at,
          readAt: row.reply_read_at,
          dev: true,
        })),
      ].sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));

      const state = {
        online: true,
        friends,
        incoming,
        outgoing,
        mail: mailItems,
        error: mailResult.error ? '手紙台帳を読み込めませんでした' : '',
      };
      bridge?.syncSocialState?.(state);
      return state;
    } catch (error) {
      if (revision === refreshRevision) {
        bridge?.syncSocialState?.({
          online: true,
          friends: [],
          incoming: [],
          outgoing: [],
          mail: [],
          error: error?.message || '縁者台帳を読み込めませんでした',
        });
      }
      throw error;
    }
  }

  function relationshipWith(peerId) {
    const ownId = userId();
    return friendships.find(row => (
      (row.requester_id === ownId && row.addressee_id === peerId)
      || (row.requester_id === peerId && row.addressee_id === ownId)
    ));
  }

  async function sendFriendRequest(rawPeerId) {
    const ownId = userId();
    const peerId = cleanId(rawPeerId);
    if (!ownId || !VALID_ID.test(peerId) || peerId === ownId)
      throw new Error('申請する魂を確認できません');
    if (!friendships.length) await refresh();
    let existing = relationshipWith(peerId);
    if (existing?.status === 'accepted') return { state: 'accepted', id: existing.id };
    if (existing?.status === 'pending') {
      if (existing.addressee_id === ownId) return acceptFriendRequest(peerId);
      return { state: 'pending', id: existing.id };
    }
    if (existing) {
      const removed = await client.from('friendships').delete().eq('id', existing.id);
      if (removed.error) throw removed.error;
    }
    const { data, error } = await client
      .from('friendships')
      .insert({ requester_id: ownId, addressee_id: peerId, status: 'pending' })
      .select('id')
      .single();
    if (error) throw error;
    await refresh();
    return { state: 'pending', id: data?.id || '' };
  }

  async function answerFriendRequest(rawPeerId, accepted) {
    const peerId = cleanId(rawPeerId);
    if (!userId() || !VALID_ID.test(peerId)) throw new Error('申請を確認できません');
    await refresh();
    const row = relationshipWith(peerId);
    if (!row || row.status !== 'pending' || row.addressee_id !== userId())
      throw new Error('この申請はすでに処理されています');
    const { error } = await client
      .from('friendships')
      .update({
        status: accepted ? 'accepted' : 'declined',
        responded_at: new Date().toISOString(),
      })
      .eq('id', row.id);
    if (error) throw error;
    await refresh();
    return { state: accepted ? 'accepted' : 'declined', id: row.id };
  }

  const acceptFriendRequest = peerId => answerFriendRequest(peerId, true);
  const declineFriendRequest = peerId => answerFriendRequest(peerId, false);

  async function removeFriend(rawPeerId) {
    const peerId = cleanId(rawPeerId);
    if (!userId() || !VALID_ID.test(peerId)) throw new Error('縁者を確認できません');
    await refresh();
    const row = relationshipWith(peerId);
    if (!row) return;
    const { error } = await client.from('friendships').delete().eq('id', row.id);
    if (error) throw error;
    await refresh();
  }

  async function sendMail(rawRecipientId, rawBody, rawGift = null) {
    const ownId = userId();
    const recipientId = cleanId(rawRecipientId);
    const body = String(rawBody || '').replace(/\r\n?/g, '\n').trim().slice(0, 240);
    if (!ownId || !VALID_ID.test(recipientId)) throw new Error('宛先を確認できません');
    if (!body) throw new Error('手紙の本文を入力してください');
    const gift = cleanGift(rawGift);
    const { error } = await client.from('soul_mail').insert({
      sender_id: ownId,
      recipient_id: recipientId,
      body,
      attachment_kind: gift?.kind || null,
      attachment_id: gift?.id || null,
      attachment_name: gift?.name || null,
    });
    if (error) throw error;
    return true;
  }

  async function claimMailGift(mailId) {
    const id = cleanId(mailId);
    if (!userId() || !VALID_ID.test(id)) throw new Error('添付品を確認できません');
    const { data, error } = await client.rpc('claim_soul_mail_attachment', { p_mail_id: id });
    if (error) throw error;
    await refresh();
    return data;
  }

  async function markMailRead(mailId) {
    // 目安箱の返礼(fb-〜)は feedback_box 側の既読を更新する
    if (String(mailId || '').startsWith('fb-')) {
      const feedbackId = cleanId(String(mailId).slice(3));
      if (!userId() || !VALID_ID.test(feedbackId)) return;
      const { error } = await client
        .from('feedback_box')
        .update({ reply_read_at: new Date().toISOString() })
        .eq('id', feedbackId)
        .eq('user_id', userId());
      if (error) throw error;
      await refresh();
      return;
    }
    if (!userId() || !VALID_ID.test(cleanId(mailId))) return;
    const { error } = await client
      .from('soul_mail')
      .update({ read_at: new Date().toISOString() })
      .eq('id', mailId)
      .eq('recipient_id', userId());
    if (error) throw error;
    await refresh();
  }

  async function submitFeedback(rawBody, rawName) {
    const ownId = userId();
    if (!ownId) throw new Error('目安箱への投書には魂籍ログインが必要です');
    const body = String(rawBody || '').replace(/\r\n?/g, '\n').trim().slice(0, 500);
    if (!body) throw new Error('投書の内容を入力してください');
    const { error } = await client.from('feedback_box').insert({
      user_id: ownId,
      soul_name: cleanName(rawName),
      body,
    });
    if (error) throw error;
    return true;
  }

  async function setAccount(nextSession) {
    clearPoll();
    session = nextSession || null;
    friendships = [];
    if (!session) {
      emptyState();
      return;
    }
    await refresh().catch(() => {});
    pollTimer = window.setInterval(() => {
      if (!document.hidden) refresh().catch(() => {});
    }, SOCIAL_POLL_MS);
  }

  async function stop() {
    clearPoll();
    refreshRevision++;
    session = null;
    friendships = [];
    emptyState();
  }

  return {
    setAccount,
    refresh,
    sendFriendRequest,
    acceptFriendRequest,
    declineFriendRequest,
    removeFriend,
    sendMail,
    claimMailGift,
    markMailRead,
    submitFeedback,
    stop,
  };
}
