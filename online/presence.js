const LOOP_INTERVAL_MS = 100;
const POSITION_INTERVAL_MS = 200;
const IDLE_HEARTBEAT_MS = 2000;
const VALID_ZONE = /^(field|cave|cave2|cave3|dg[1-5])$/;
const VALID_DIRECTION = new Set(['up', 'down', 'left', 'right']);
const VALID_ATTACK_KIND = new Set(['melee', 'cast']);

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
    seq: Math.max(0, Math.trunc(cleanNumber(raw.seq, 0))),
    lastSeen: Date.now(),
  };
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
  let sequence = 0;

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
    channel.send({
      type: 'broadcast',
      event: 'position',
      payload: payloadFor(snapshot),
    }).catch(() => {});
  }

  function tick() {
    const snapshot = bridge?.getRealtimeState?.();
    const nextZone = session && snapshot?.active && !document.hidden
      && VALID_ZONE.test(snapshot.zone) ? snapshot.zone : '';

    if (nextZone !== channelZone) {
      void switchChannel(nextZone, snapshot || {});
      return;
    }
    if (nextZone) sendPosition(snapshot);

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
    if (!session || previousUserId !== nextUserId) await closeChannel();
    tick();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) void closeChannel();
    else tick();
  });
  window.addEventListener('pagehide', () => { void closeChannel(); });

  setIndicator(false);
  return { setAccount, stop: closeChannel };
}
