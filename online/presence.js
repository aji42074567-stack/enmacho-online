const LOOP_INTERVAL_MS = 100;
const POSITION_INTERVAL_MS = 200;
const IDLE_HEARTBEAT_MS = 2000;
const VALID_ZONE = /^(field|cave|cave2|cave3|dg[1-5])$/;
const VALID_DIRECTION = new Set(['up', 'down', 'left', 'right']);
const VALID_ATTACK_KIND = new Set([
  'melee', 'bolt', 'fire', 'heal',
  'potion_s', 'potion_m', 'potion_l', 'haste', 'crit',
]);
// フレンド・チームは未実装。実装したらここへ追加する。
const VALID_CHAT_CHANNEL = new Set(['general', 'world']);
const CHAT_MIN_INTERVAL_MS = 600;
const CHAT_MAX_LENGTH = 60;
// 全体チャンネルのトピック。RLSポリシー(game:zone:%)に合わせた命名で、
// 'world'は実在ゾーン名と衝突しない。
const WORLD_TOPIC = 'game:zone:world';

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
    lastSeen: Date.now(),
  };
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

  async function closeWorldChannel() {
    const oldChannel = worldChannel;
    worldChannel = null;
    worldSubscribed = false;
    worldOpening = false;
    bridge?.setWorldChatOnline?.(false);
    if (!oldChannel) return;
    try {
      await client.removeChannel(oldChannel);
    } catch {}
  }

  function openWorldChannel() {
    if (worldChannel || worldOpening || !session) return;
    worldOpening = true;
    const activeChannel = client.channel(WORLD_TOPIC, {
      config: { private: true, broadcast: { self: false, ack: false } },
    });
    worldChannel = activeChannel;
    activeChannel
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
      .subscribe(status => {
        if (activeChannel !== worldChannel) return;
        worldOpening = false;
        if (status === 'SUBSCRIBED') {
          worldSubscribed = true;
          bridge?.setWorldChatOnline?.(true);
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          worldSubscribed = false;
          worldRetryAt = Date.now() + 5_000;
          void closeWorldChannel();
        }
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
      }
    }
  }

  function tick() {
    const snapshot = bridge?.getRealtimeState?.();
    const nextZone = session && snapshot?.active && !document.hidden
      && VALID_ZONE.test(snapshot.zone) ? snapshot.zone : '';

    // 全体チャンネルはゾーンに依存せず、プレイ中ずっと接続する
    const wantWorld = Boolean(session && snapshot?.active && !document.hidden);
    if (wantWorld && !worldChannel && Date.now() >= worldRetryAt) openWorldChannel();
    else if (!wantWorld && worldChannel) void closeWorldChannel();

    if (nextZone !== channelZone) {
      void switchChannel(nextZone, snapshot || {});
      return;
    }
    if (nextZone) {
      sendPosition(snapshot);
      sendChatOutbox(snapshot);
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
    }
    tick();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      void closeChannel();
      void closeWorldChannel();
    } else tick();
  });
  window.addEventListener('pagehide', () => {
    void closeChannel();
    void closeWorldChannel();
  });

  setIndicator(false);
  return {
    setAccount,
    stop: () => Promise.allSettled([closeChannel(), closeWorldChannel()]),
  };
}
