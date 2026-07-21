const LOOP_INTERVAL_MS = 100;
const POSITION_INTERVAL_MS = 200;
const IDLE_HEARTBEAT_MS = 2000;
const VALID_ZONE = /^(field|cave|cave2|cave3|dg[1-5])$/;
const VALID_DIRECTION = new Set(['up', 'down', 'left', 'right']);
const VALID_ATTACK_KIND = new Set([
  'melee', 'bolt', 'fire', 'heal',
  'potion_s', 'potion_m', 'potion_l', 'haste', 'crit',
]);
const VALID_CHAT_CHANNEL = new Set(['general', 'world', 'team']);
const CHAT_MIN_INTERVAL_MS = 600;
const CHAT_MAX_LENGTH = 60;
// 全体チャンネルのトピック。RLSポリシー(game:zone:%)に合わせた命名で、
// 'world'は実在ゾーン名と衝突しない。個人受信箱(u:)とパーティ(party:)も同じ流儀。
const WORLD_TOPIC = 'game:zone:world';
const inboxTopic = userId => `game:zone:u:${userId}`;
const partyTopic = partyId => `game:zone:party:${partyId}`;
const VALID_UUID = /^[0-9a-f-]{16,64}$/i;
const VALID_INVITE_KIND = new Set(['team', 'friend']);
const VALID_STAGE = new Set(['deceased', 'rebirth_candidate', 'reincarnated']);

// 実績サマリー(プレイヤーカード表示用)。位置ペイロードに同乗する
function normalizeAch(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    kills: Math.max(0, Math.min(999999, Math.trunc(cleanNumber(raw.kills, 0)))),
    trial: Boolean(raw.trial),
    oniKing: Boolean(raw.oniKing),
    dragon: Boolean(raw.dragon),
    stage: VALID_STAGE.has(raw.stage) ? raw.stage : 'deceased',
  };
}

const newSessionId = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};

const cleanText = (value, maxLength) => String(value || '')
  .replace(/\s+/g, ' ').trim().slice(0, maxLength);

const cleanNumber = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

function normalizeRemote(raw, expectedZone, ownUserId, ownSessionId) {
  if (!raw || typeof raw !== 'object') return null;
  const userId = cleanText(raw.userId, 64);
  const sessionId = cleanText(raw.sessionId, 96);
  const zone = cleanText(raw.zone, 16);
  if (!userId || !sessionId || userId === ownUserId || sessionId === ownSessionId) return null;
  if (zone !== expectedZone || !VALID_ZONE.test(zone)) return null;

  const x = cleanNumber(raw.x, NaN);
  const y = cleanNumber(raw.y, NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < -2 || x > 74 || y < -2 || y > 74) {
    return null;
  }
  const rawTargetX = cleanNumber(raw.targetX, x);
  const rawTargetY = cleanNumber(raw.targetY, y);
  const targetX = rawTargetX >= -2 && rawTargetX <= 74 ? rawTargetX : x;
  const targetY = rawTargetY >= -2 && rawTargetY <= 74 ? rawTargetY : y;

  return {
    userId,
    sessionId,
    displayName: cleanText(raw.displayName, 16) || 'ナナシ',
    gender: raw.gender === 'f' ? 'f' : 'm',
    level: Math.max(1, Math.min(999, Math.trunc(cleanNumber(raw.level, 1)))),
    zone,
    x,
    y,
    dir: VALID_DIRECTION.has(raw.dir) ? raw.dir : 'down',
    moving: Boolean(raw.moving),
    dead: Boolean(raw.dead),
    attackSeq: Math.max(0, Math.trunc(cleanNumber(raw.attackSeq, 0))),
    attackKind: VALID_ATTACK_KIND.has(raw.attackKind) ? raw.attackKind : 'melee',
    targetX,
    targetY,
    seq: Math.max(0, Math.trunc(cleanNumber(raw.seq, 0))),
    ach: normalizeAch(raw.ach),
    hp: Math.max(0, Math.min(99999, Math.trunc(cleanNumber(raw.hp, 0)))),
    maxHp: Math.max(0, Math.min(99999, Math.trunc(cleanNumber(raw.maxHp, 0)))),
    mp: Math.max(0, Math.min(99999, Math.trunc(cleanNumber(raw.mp, 0)))),
    maxMp: Math.max(0, Math.min(99999, Math.trunc(cleanNumber(raw.maxMp, 0)))),
    lastSeen: Date.now(),
  };
}

function normalizeInvite(raw, ownSessionId) {
  const identity = chatIdentity(raw, ownSessionId);
  if (!identity) return null;
  if (!VALID_INVITE_KIND.has(raw.kind)) return null;
  const partyId = cleanText(raw.partyId, 64);
  if (raw.kind === 'team' && !VALID_UUID.test(partyId)) return null;
  return { kind: raw.kind, partyId: raw.kind === 'team' ? partyId : '', from: identity };
}

function normalizeInviteReply(raw, ownSessionId) {
  const identity = chatIdentity(raw, ownSessionId);
  if (!identity) return null;
  if (!VALID_INVITE_KIND.has(raw.kind)) return null;
  return {
    kind: raw.kind,
    accepted: Boolean(raw.accepted),
    partyId: cleanText(raw.partyId, 64),
    from: identity,
  };
}

function normalizePartyMember(raw, ownSessionId) {
  if (!raw || typeof raw !== 'object') return null;
  const userId = cleanText(raw.userId, 64);
  const sessionId = cleanText(raw.sessionId, 96);
  if (!userId || !sessionId) return null;
  return {
    userId,
    sessionId,
    self: sessionId === ownSessionId,
    displayName: cleanText(raw.displayName, 16) || 'ナナシ',
    level: Math.max(1, Math.min(999, Math.trunc(cleanNumber(raw.level, 1)))),
    zone: cleanText(raw.zone, 16),
  };
}

function normalizeGlobalPlayer(raw, ownSessionId) {
  return normalizePartyMember(raw, ownSessionId);
}

function chatIdentity(raw, ownSessionId) {
  if (!raw || typeof raw !== 'object') return null;
  const userId = cleanText(raw.userId, 64);
  const sessionId = cleanText(raw.sessionId, 96);
  if (!userId || !sessionId || sessionId === ownSessionId) return null;
  return {
    userId,
    sessionId,
    displayName: cleanText(raw.displayName, 16) || 'ナナシ',
    level: Math.max(1, Math.min(999, Math.trunc(cleanNumber(raw.level, 1)))),
  };
}

function normalizeChatMessage(raw, expectedZone, ownSessionId) {
  const identity = chatIdentity(raw, ownSessionId);
  if (!identity) return null;
  const zone = cleanText(raw.zone, 16);
  if (zone !== expectedZone || !VALID_ZONE.test(zone)) return null;
  if (raw.channel !== 'general') return null;
  const text = cleanText(raw.text, CHAT_MAX_LENGTH);
  if (!text) return null;
  return { ...identity, channel: 'general', text };
}

function normalizeWorldChat(raw, ownSessionId) {
  const identity = chatIdentity(raw, ownSessionId);
  if (!identity) return null;
  if (raw.channel !== 'world') return null;
  const text = cleanText(raw.text, CHAT_MAX_LENGTH);
  if (!text) return null;
  return { ...identity, channel: 'world', text };
}

function normalizeDropNotice(raw, ownSessionId) {
  const identity = chatIdentity(raw, ownSessionId);
  if (!identity) return null;
  const itemName = cleanText(raw.itemName, 24);
  const mobName = cleanText(raw.mobName, 24);
  if (!itemName || !mobName) return null;
  return { ...identity, itemName, mobName };
}

export function createPresenceController(client, bridge = window.EnmaGameBridge) {
  const sessionId = newSessionId();
  const remotes = new Map();
  let session = null;
  let profile = null;
  let channel = null;
  let channelZone = '';
  let subscribed = false;
  let transitioning = false;
  let timer = 0;
  let lastSentAt = 0;
  let lastSentKey = '';
  let lastSentAttackSeq = 0;
  let lastChatSentAt = 0;
  let sequence = 0;
  let worldChannel = null;
  let worldSubscribed = false;
  let worldOpening = false;
  let worldRetryAt = 0;
  let worldTrackedKey = '';
  let inboxChannel = null;
  let inboxOpening = false;
  let inboxRetryAt = 0;
  let inboxUserId = '';
  let partyChannel = null;
  let partySubscribed = false;
  let partyOpening = false;
  let partyRetryAt = 0;
  let partyId = '';
  let partyTrackedKey = '';

  function identityFor(snapshot = {}) {
    return {
      userId: session?.user?.id || '',
      sessionId,
      displayName: cleanText(profile?.display_name || snapshot.displayName, 16) || 'ナナシ',
      gender: snapshot.gender === 'f' || (snapshot.gender !== 'm' && profile?.avatar_key === 'f')
        ? 'f' : 'm',
      level: Math.max(1, Math.min(999, Math.trunc(cleanNumber(snapshot.level, 1)))),
    };
  }

  function payloadFor(snapshot = {}) {
    return {
      ...identityFor(snapshot),
      ach: normalizeAch(snapshot.ach) || undefined,
      hp: Math.max(0, Math.trunc(cleanNumber(snapshot.hp, 0))),
      maxHp: Math.max(0, Math.trunc(cleanNumber(snapshot.maxHp, 0))),
      mp: Math.max(0, Math.trunc(cleanNumber(snapshot.mp, 0))),
      maxMp: Math.max(0, Math.trunc(cleanNumber(snapshot.maxMp, 0))),
      zone: cleanText(snapshot.zone, 16),
      x: Math.round(cleanNumber(snapshot.x) * 1000) / 1000,
      y: Math.round(cleanNumber(snapshot.y) * 1000) / 1000,
      dir: VALID_DIRECTION.has(snapshot.dir) ? snapshot.dir : 'down',
      moving: Boolean(snapshot.moving),
      dead: Boolean(snapshot.dead),
      attackSeq: Math.max(0, Math.trunc(cleanNumber(snapshot.attackSeq, 0))),
      attackKind: VALID_ATTACK_KIND.has(snapshot.attackKind) ? snapshot.attackKind : 'melee',
      targetX: Math.round(cleanNumber(snapshot.targetX, snapshot.x) * 1000) / 1000,
      targetY: Math.round(cleanNumber(snapshot.targetY, snapshot.y) * 1000) / 1000,
      seq: ++sequence,
      sentAt: Date.now(),
    };
  }

  function setIndicator(connected, remoteCount = 0) {
    const badge = document.getElementById('onlineCount');
    const button = document.getElementById('accountBtn');
    const total = connected ? remoteCount + 1 : 0;
    if (badge) {
      badge.hidden = !connected;
      badge.textContent = String(total);
    }
    button?.classList.toggle('realtime', connected);
    bridge?.setChatOnline?.(connected);
    if (button && connected) {
      button.title = `魂籍を開く（同じ区域に${total}人）`;
      button.setAttribute('aria-label', `魂籍を開く。同じ区域に${total}人`);
    } else if (button) {
      button.title = '魂籍を開く';
      button.setAttribute('aria-label', '魂籍を開く');
    }
  }

  function publishRemotes() {
    const latestByUser = new Map();
    for (const remote of remotes.values()) {
      const current = latestByUser.get(remote.userId);
      if (!current || remote.lastSeen > current.lastSeen) latestByUser.set(remote.userId, remote);
    }
    const players = [...latestByUser.values()];
    bridge?.setRemotePlayers?.(players);
    setIndicator(subscribed, players.length);
  }

  function upsertRemote(raw) {
    const remote = normalizeRemote(
      raw,
      channelZone,
      session?.user?.id || '',
      sessionId,
    );
    if (!remote) return;
    const previous = remotes.get(remote.sessionId);
    if (previous && remote.seq && previous.seq && remote.seq < previous.seq) return;
    remotes.set(remote.sessionId, { ...previous, ...remote });
  }

  function syncPresenceState(activeChannel) {
    if (activeChannel !== channel) return;
    const liveSessionIds = new Set();
    const presenceState = activeChannel.presenceState();
    for (const entries of Object.values(presenceState)) {
      for (const entry of entries || []) {
        const remote = normalizeRemote(
          entry,
          channelZone,
          session?.user?.id || '',
          sessionId,
        );
        if (!remote) continue;
        liveSessionIds.add(remote.sessionId);
        const previous = remotes.get(remote.sessionId);
        if (previous && remote.seq && previous.seq && remote.seq < previous.seq) continue;
        remotes.set(remote.sessionId, { ...previous, ...remote });
      }
    }
    for (const key of remotes.keys()) {
      if (!liveSessionIds.has(key)) remotes.delete(key);
    }
    publishRemotes();
  }

  function memberPayload(snapshot = {}) {
    return {
      ...identityFor(snapshot),
      zone: cleanText(snapshot.zone, 16),
      sentAt: Date.now(),
    };
  }

  function syncWorldPresence(activeChannel) {
    if (activeChannel !== worldChannel) return;
    const byUser = new Map();
    for (const entries of Object.values(activeChannel.presenceState())) {
      for (const entry of entries || []) {
        const player = normalizeGlobalPlayer(entry, sessionId);
        if (player && !player.self) byUser.set(player.userId, player);
      }
    }
    bridge?.setGlobalOnline?.([...byUser.values()]);
  }

  async function closeWorldChannel() {
    const oldChannel = worldChannel;
    worldChannel = null;
    worldSubscribed = false;
    worldOpening = false;
    worldTrackedKey = '';
    bridge?.setWorldChatOnline?.(false);
    bridge?.setGlobalOnline?.([]);
    if (!oldChannel) return;
    try {
      await oldChannel.untrack();
    } catch {}
    try {
      await client.removeChannel(oldChannel);
    } catch {}
  }

  function openWorldChannel() {
    if (worldChannel || worldOpening || !session) return;
    worldOpening = true;
    const activeChannel = client.channel(WORLD_TOPIC, {
      config: {
        private: true,
        presence: { key: sessionId },
        broadcast: { self: false, ack: false },
      },
    });
    worldChannel = activeChannel;
    activeChannel
      .on('presence', { event: 'sync' }, () => syncWorldPresence(activeChannel))
      .on('broadcast', { event: 'chat' }, ({ payload }) => {
        if (activeChannel !== worldChannel) return;
        const message = normalizeWorldChat(payload, sessionId);
        if (message) bridge?.receiveChatMessage?.(message);
      })
      .on('broadcast', { event: 'drop' }, ({ payload }) => {
        if (activeChannel !== worldChannel) return;
        const notice = normalizeDropNotice(payload, sessionId);
        if (notice) bridge?.receiveDropNotice?.(notice);
      })
      .subscribe(async status => {
        if (activeChannel !== worldChannel) return;
        worldOpening = false;
        if (status === 'SUBSCRIBED') {
          worldSubscribed = true;
          bridge?.setWorldChatOnline?.(true);
          const snapshot = bridge?.getRealtimeState?.() || {};
          try {
            await activeChannel.track(memberPayload(snapshot));
            worldTrackedKey = cleanText(snapshot.zone, 16);
          } catch {}
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          worldSubscribed = false;
          worldRetryAt = Date.now() + 5_000;
          void closeWorldChannel();
        }
      });
  }

  /* ---- 個人受信箱: チーム勧誘・フレンド申請が届く ---- */
  async function closeInboxChannel() {
    const oldChannel = inboxChannel;
    inboxChannel = null;
    inboxOpening = false;
    inboxUserId = '';
    if (!oldChannel) return;
    try {
      await client.removeChannel(oldChannel);
    } catch {}
  }

  function openInboxChannel() {
    const userId = session?.user?.id || '';
    if (inboxChannel || inboxOpening || !userId) return;
    inboxOpening = true;
    inboxUserId = userId;
    const activeChannel = client.channel(inboxTopic(userId), {
      config: { private: true, broadcast: { self: false, ack: false } },
    });
    inboxChannel = activeChannel;
    activeChannel
      .on('broadcast', { event: 'invite' }, ({ payload }) => {
        if (activeChannel !== inboxChannel) return;
        const invite = normalizeInvite(payload, sessionId);
        if (invite) bridge?.receiveInvite?.(invite);
      })
      .on('broadcast', { event: 'invite_reply' }, ({ payload }) => {
        if (activeChannel !== inboxChannel) return;
        const reply = normalizeInviteReply(payload, sessionId);
        if (reply) bridge?.receiveInviteReply?.(reply);
      })
      .subscribe(status => {
        if (activeChannel !== inboxChannel) return;
        inboxOpening = false;
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          inboxRetryAt = Date.now() + 5_000;
          void closeInboxChannel();
        }
      });
  }

  /* ---- パーティ(チーム)チャンネル: 在席がメンバー一覧、broadcastがチームチャット ---- */
  function syncPartyPresence(activeChannel) {
    if (activeChannel !== partyChannel) return;
    const byUser = new Map();
    for (const entries of Object.values(activeChannel.presenceState())) {
      for (const entry of entries || []) {
        const member = normalizePartyMember(entry, sessionId);
        if (member) byUser.set(member.userId, member);
      }
    }
    bridge?.setPartyMembers?.([...byUser.values()]);
  }

  async function closePartyChannel() {
    const oldChannel = partyChannel;
    partyChannel = null;
    partySubscribed = false;
    partyOpening = false;
    partyTrackedKey = '';
    bridge?.setTeamChatOnline?.(false);
    bridge?.setPartyMembers?.([]);
    if (!oldChannel) return;
    try {
      await oldChannel.untrack();
    } catch {}
    try {
      await client.removeChannel(oldChannel);
    } catch {}
  }

  function openPartyChannel(id) {
    if (partyChannel || partyOpening || !session || !VALID_UUID.test(id)) return;
    partyOpening = true;
    const activeChannel = client.channel(partyTopic(id), {
      config: {
        private: true,
        presence: { key: sessionId },
        broadcast: { self: false, ack: false },
      },
    });
    partyChannel = activeChannel;
    activeChannel
      .on('presence', { event: 'sync' }, () => syncPartyPresence(activeChannel))
      .on('broadcast', { event: 'chat' }, ({ payload }) => {
        if (activeChannel !== partyChannel) return;
        const identity = chatIdentity(payload, sessionId);
        const text = cleanText(payload?.text, CHAT_MAX_LENGTH);
        if (!identity || !text) return;
        bridge?.receiveChatMessage?.({ ...identity, channel: 'team', text });
      })
      .on('broadcast', { event: 'kill' }, ({ payload }) => {
        if (activeChannel !== partyChannel) return;
        const from = chatIdentity(payload, sessionId);
        if (!from) return;
        const xp = Math.max(1, Math.min(99999, Math.trunc(cleanNumber(payload.xp, 0))));
        const x = cleanNumber(payload.x, NaN), y = cleanNumber(payload.y, NaN);
        const zone = cleanText(payload.zone, 16);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !zone) return;
        bridge?.receivePartyKill?.({ from, xp, x, y, zone,
          mobName: cleanText(payload.mobName, 24) });
      })
      .on('broadcast', { event: 'heal' }, ({ payload }) => {
        if (activeChannel !== partyChannel) return;
        const from = chatIdentity(payload, sessionId);
        if (!from) return;
        const amount = Math.max(1, Math.min(9999, Math.trunc(cleanNumber(payload.amount, 0))));
        const x = cleanNumber(payload.x, NaN), y = cleanNumber(payload.y, NaN);
        const zone = cleanText(payload.zone, 16);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !zone) return;
        bridge?.receivePartyHeal?.({ from, amount, x, y, zone });
      })
      .on('broadcast', { event: 'loot' }, ({ payload }) => {
        if (activeChannel !== partyChannel) return;
        // 分配ドロップは宛先本人だけが受け取る
        if (cleanText(payload?.toUserId, 64) !== (session?.user?.id || '')) return;
        const from = chatIdentity(payload, sessionId);
        if (!from) return;
        const loot = ['nectar', 'blood', 'wscroll', 'ascroll'].includes(payload.loot)
          ? payload.loot : '';
        if (!loot) return;
        bridge?.receivePartyLoot?.({ from, loot, mobName: cleanText(payload.mobName, 24) });
      })
      .subscribe(async status => {
        if (activeChannel !== partyChannel) return;
        partyOpening = false;
        if (status === 'SUBSCRIBED') {
          partySubscribed = true;
          bridge?.setTeamChatOnline?.(true);
          const snapshot = bridge?.getRealtimeState?.() || {};
          try {
            await activeChannel.track(memberPayload(snapshot));
            partyTrackedKey = cleanText(snapshot.zone, 16);
          } catch {}
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          partySubscribed = false;
          partyRetryAt = Date.now() + 5_000;
          void closePartyChannel();
        }
      });
  }

  // 相手の受信箱へ1回だけ届ける(未購読チャンネルのsendはHTTP経由で送られる)
  function sendToInbox(targetUserId, event, payload) {
    if (!VALID_UUID.test(targetUserId)) return;
    const sender = client.channel(inboxTopic(targetUserId), {
      config: { private: true, broadcast: { self: false, ack: false } },
    });
    sender.send({ type: 'broadcast', event, payload })
      .catch(() => {})
      .finally(() => {
        try { client.removeChannel(sender); } catch {}
      });
  }

  async function closeChannel() {
    const oldChannel = channel;
    channel = null;
    channelZone = '';
    subscribed = false;
    lastSentKey = '';
    lastSentAttackSeq = 0;
    remotes.clear();
    publishRemotes();
    if (!oldChannel) return;
    try {
      await oldChannel.untrack();
    } catch {}
    try {
      await client.removeChannel(oldChannel);
    } catch {}
  }

  async function switchChannel(nextZone, snapshot) {
    if (transitioning) return;
    transitioning = true;
    try {
      await closeChannel();
      if (!session || !VALID_ZONE.test(nextZone) || document.hidden) return;

      const activeChannel = client.channel(`game:zone:${nextZone}`, {
        config: {
          private: true,
          presence: { key: sessionId },
          broadcast: { self: false, ack: false },
        },
      });
      channel = activeChannel;
      channelZone = nextZone;

      activeChannel
        .on('presence', { event: 'sync' }, () => syncPresenceState(activeChannel))
        .on('broadcast', { event: 'position' }, ({ payload }) => {
          if (activeChannel !== channel) return;
          upsertRemote(payload);
          publishRemotes();
        })
        .on('broadcast', { event: 'chat' }, ({ payload }) => {
          if (activeChannel !== channel) return;
          const message = normalizeChatMessage(payload, channelZone, sessionId);
          if (message) bridge?.receiveChatMessage?.(message);
        })
        .on('broadcast', { event: 'attack' }, ({ payload }) => {
          if (activeChannel !== channel) return;
          const action = normalizeRemote(
            payload,
            channelZone,
            session?.user?.id || '',
            sessionId,
          );
          if (!action) return;
          const previous = remotes.get(action.sessionId);
          if (!previous || !action.seq || !previous.seq || action.seq >= previous.seq) {
            remotes.set(action.sessionId, { ...previous, ...action });
          }
          // 位置更新とは別経路で、受信した瞬間に一度だけ攻撃姿勢を始める。
          publishRemotes();
          bridge?.playRemoteAttack?.(action);
        })
        .subscribe(async status => {
          if (activeChannel !== channel) return;
          if (status === 'SUBSCRIBED') {
            subscribed = true;
            const current = bridge?.getRealtimeState?.() || snapshot;
            try {
              await activeChannel.track(payloadFor(current));
            } catch {}
            lastSentAt = 0;
            lastSentKey = '';
            lastSentAttackSeq = Math.max(
              0,
              Math.trunc(cleanNumber(current?.attackSeq, 0)),
            );
            publishRemotes();
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            subscribed = false;
            remotes.clear();
            publishRemotes();
          }
        });
    } finally {
      transitioning = false;
    }
  }

  function sendPosition(snapshot) {
    if (!channel || !subscribed || snapshot.zone !== channelZone) return;
    const now = Date.now();
    const identity = identityFor(snapshot);
    const attackSeq = Math.max(0, Math.trunc(cleanNumber(snapshot.attackSeq, 0)));
    const key = [
      Math.round(cleanNumber(snapshot.x) * 100),
      Math.round(cleanNumber(snapshot.y) * 100),
      snapshot.dir,
      Boolean(snapshot.moving),
      Boolean(snapshot.dead),
      attackSeq,
      VALID_ATTACK_KIND.has(snapshot.attackKind) ? snapshot.attackKind : 'melee',
      Math.round(cleanNumber(snapshot.targetX, snapshot.x) * 100),
      Math.round(cleanNumber(snapshot.targetY, snapshot.y) * 100),
      identity.displayName,
      identity.gender,
      identity.level,
      Math.round(cleanNumber(snapshot.hp) / 5),
      Math.round(cleanNumber(snapshot.mp) / 5),
    ].join('|');
    const changed = key !== lastSentKey;
    const attackChanged = attackSeq !== lastSentAttackSeq;
    const due = attackChanged
      || now - lastSentAt >= (changed ? POSITION_INTERVAL_MS : IDLE_HEARTBEAT_MS);
    if (!due) return;
    lastSentAt = now;
    lastSentKey = key;
    lastSentAttackSeq = attackSeq;
    const payload = payloadFor(snapshot);
    if (attackChanged) {
      channel.send({
        type: 'broadcast',
        event: 'attack',
        payload,
      }).catch(() => {});
    }
    channel.send({
      type: 'broadcast',
      event: 'position',
      payload,
    }).catch(() => {});
  }

  function sendChatOutbox(snapshot) {
    const outbox = bridge?.drainChatOutbox?.();
    if (!Array.isArray(outbox) || !outbox.length) return;
    for (const item of outbox.slice(0, 4)) {
      const now = Date.now();
      if (item?.channel === 'drop') {
        // レアドロップ告知は全体チャンネルへ。連投制限の対象外(そもそも稀)
        if (!worldChannel || !worldSubscribed) continue;
        const itemName = cleanText(item.itemName, 24);
        const mobName = cleanText(item.mobName, 24);
        if (!itemName || !mobName) continue;
        worldChannel.send({
          type: 'broadcast',
          event: 'drop',
          payload: { ...identityFor(snapshot), itemName, mobName, sentAt: now },
        }).catch(() => {});
        continue;
      }
      const text = cleanText(item?.text, CHAT_MAX_LENGTH);
      if (!text || !VALID_CHAT_CHANNEL.has(item?.channel)) continue;
      if (now - lastChatSentAt < CHAT_MIN_INTERVAL_MS) continue;
      if (item.channel === 'general') {
        if (!channel || !subscribed || snapshot.zone !== channelZone) continue;
        lastChatSentAt = now;
        channel.send({
          type: 'broadcast',
          event: 'chat',
          payload: {
            ...identityFor(snapshot),
            zone: channelZone,
            channel: 'general',
            text,
            sentAt: now,
          },
        }).catch(() => {});
      } else if (item.channel === 'world') {
        if (!worldChannel || !worldSubscribed) continue;
        lastChatSentAt = now;
        worldChannel.send({
          type: 'broadcast',
          event: 'chat',
          payload: { ...identityFor(snapshot), channel: 'world', text, sentAt: now },
        }).catch(() => {});
      } else if (item.channel === 'team') {
        if (!partyChannel || !partySubscribed) continue;
        lastChatSentAt = now;
        partyChannel.send({
          type: 'broadcast',
          event: 'chat',
          payload: { ...identityFor(snapshot), channel: 'team', text, sentAt: now },
        }).catch(() => {});
      }
    }
  }

  // チーム勧誘・フレンド申請と、その返事を相手の受信箱へ送る
  function sendControlOutbox(snapshot) {
    const outbox = bridge?.drainControlOutbox?.();
    if (!Array.isArray(outbox) || !outbox.length) return;
    for (const item of outbox.slice(0, 4)) {
      const targetUserId = cleanText(item?.targetUserId, 64);
      if (!VALID_UUID.test(targetUserId)) continue;
      if (item.type === 'invite' && VALID_INVITE_KIND.has(item.kind)) {
        const payload = {
          ...identityFor(snapshot),
          kind: item.kind,
          partyId: cleanText(item.partyId, 64),
          sentAt: Date.now(),
        };
        if (item.kind === 'team' && !VALID_UUID.test(payload.partyId)) continue;
        sendToInbox(targetUserId, 'invite', payload);
      } else if (item.type === 'party_kill' || item.type === 'party_heal'
        || item.type === 'party_loot') {
        if (!partyChannel || !partySubscribed) continue;
        const base = { ...identityFor(snapshot), sentAt: Date.now() };
        if (item.type === 'party_kill') {
          partyChannel.send({ type: 'broadcast', event: 'kill', payload: { ...base,
            xp: Math.trunc(cleanNumber(item.xp, 0)),
            x: cleanNumber(item.x, 0), y: cleanNumber(item.y, 0),
            zone: cleanText(item.zone, 16),
            mobName: cleanText(item.mobName, 24) } }).catch(() => {});
        } else if (item.type === 'party_heal') {
          partyChannel.send({ type: 'broadcast', event: 'heal', payload: { ...base,
            amount: Math.trunc(cleanNumber(item.amount, 0)),
            x: cleanNumber(item.x, 0), y: cleanNumber(item.y, 0),
            zone: cleanText(item.zone, 16) } }).catch(() => {});
        } else {
          partyChannel.send({ type: 'broadcast', event: 'loot', payload: { ...base,
            toUserId: cleanText(item.toUserId, 64),
            loot: cleanText(item.loot, 12),
            mobName: cleanText(item.mobName, 24) } }).catch(() => {});
        }
      } else if (item.type === 'invite_reply' && VALID_INVITE_KIND.has(item.kind)) {
        sendToInbox(targetUserId, 'invite_reply', {
          ...identityFor(snapshot),
          kind: item.kind,
          accepted: Boolean(item.accepted),
          partyId: cleanText(item.partyId, 64),
          sentAt: Date.now(),
        });
      }
    }
  }

  function tick() {
    const snapshot = bridge?.getRealtimeState?.();
    const nextZone = session && snapshot?.active && !document.hidden
      && VALID_ZONE.test(snapshot.zone) ? snapshot.zone : '';

    // 全体チャンネル・受信箱はゾーンに依存せず、プレイ中ずっと接続する
    const wantWorld = Boolean(session && snapshot?.active && !document.hidden);
    if (wantWorld && !worldChannel && Date.now() >= worldRetryAt) openWorldChannel();
    else if (!wantWorld && worldChannel) void closeWorldChannel();
    if (wantWorld && !inboxChannel && Date.now() >= inboxRetryAt) openInboxChannel();
    else if (!wantWorld && inboxChannel) void closeInboxChannel();

    // パーティはゲーム側の意思(getPartyState)に追従する
    const wantedPartyId = wantWorld
      ? cleanText(bridge?.getPartyState?.()?.partyId, 64) : '';
    if (wantedPartyId !== partyId) {
      partyId = wantedPartyId;
      void closePartyChannel().then(() => {
        if (partyId && VALID_UUID.test(partyId)) openPartyChannel(partyId);
      });
    } else if (partyId && !partyChannel && !partyOpening && Date.now() >= partyRetryAt) {
      openPartyChannel(partyId);
    }

    // ゾーン移動を全体/パーティの在席情報に反映(フレンド一覧などで見える)
    const zoneNow = cleanText(snapshot?.zone, 16);
    if (worldChannel && worldSubscribed && zoneNow && zoneNow !== worldTrackedKey) {
      worldTrackedKey = zoneNow;
      worldChannel.track(memberPayload(snapshot)).catch(() => {});
    }
    if (partyChannel && partySubscribed && zoneNow && zoneNow !== partyTrackedKey) {
      partyTrackedKey = zoneNow;
      partyChannel.track(memberPayload(snapshot)).catch(() => {});
    }

    if (nextZone !== channelZone) {
      void switchChannel(nextZone, snapshot || {});
      return;
    }
    if (nextZone) {
      sendPosition(snapshot);
      sendChatOutbox(snapshot);
      sendControlOutbox(snapshot);
    }

    const staleBefore = Date.now() - IDLE_HEARTBEAT_MS * 4;
    let removed = false;
    for (const [key, remote] of remotes) {
      if (remote.lastSeen < staleBefore) {
        remotes.delete(key);
        removed = true;
      }
    }
    if (removed) publishRemotes();
  }

  async function setAccount(nextSession, nextProfile = profile) {
    const previousUserId = session?.user?.id || '';
    session = nextSession || null;
    profile = nextProfile || null;
    const nextUserId = session?.user?.id || '';

    if (session?.access_token) {
      try {
        await client.realtime.setAuth(session.access_token);
      } catch {}
    }
    if (!timer) timer = window.setInterval(tick, LOOP_INTERVAL_MS);
    if (!session || previousUserId !== nextUserId) {
      await closeChannel();
      await closeWorldChannel();
      await closeInboxChannel();
      await closePartyChannel();
    }
    tick();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      void closeChannel();
      void closeWorldChannel();
      void closeInboxChannel();
      void closePartyChannel();
    } else tick();
  });
  window.addEventListener('pagehide', () => {
    void closeChannel();
    void closeWorldChannel();
    void closeInboxChannel();
    void closePartyChannel();
  });

  setIndicator(false);
  return {
    setAccount,
    stop: () => Promise.allSettled([
      closeChannel(), closeWorldChannel(), closeInboxChannel(), closePartyChannel(),
    ]),
  };
}
