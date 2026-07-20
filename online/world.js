const LOOP_INTERVAL_MS = 200;
const POSITION_INTERVAL_MS = 400;
const IDLE_HEARTBEAT_MS = 2_000;
const PROTOCOL = 'enma-world-v1';

const newSessionId = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};

const finite = (value, fallback = 0) => Number.isFinite(Number(value))
  ? Number(value) : fallback;

function websocketUrl(baseUrl, sessionId) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/world/field`;
  url.search = new URLSearchParams({ session: sessionId });
  return url.toString();
}

export function createWorldController(config, bridge = window.EnmaGameBridge) {
  const sessionId = newSessionId();
  let session = null;
  let profile = null;
  let socket = null;
  let connected = false;
  let timer = 0;
  let retryAt = 0;
  let retryDelay = 1_000;
  let lastSentAt = 0;
  let lastSentKey = '';
  let lastMessageAt = 0;

  function publishConnection(nextConnected) {
    if (connected === nextConnected) return;
    connected = nextConnected;
    bridge?.setSharedWorldConnection?.({
      connected,
      zone: connected ? 'field' : '',
    });
  }

  function closeSocket(reconnect = false) {
    const previous = socket;
    socket = null;
    publishConnection(false);
    if (previous && previous.readyState < WebSocket.CLOSING) {
      try { previous.close(1000, 'Leaving room'); } catch {}
    }
    if (reconnect && session) {
      retryAt = Date.now() + retryDelay;
      retryDelay = Math.min(10_000, retryDelay * 1.8);
    } else {
      retryAt = 0;
      retryDelay = 1_000;
    }
  }

  function onMessage(event) {
    lastMessageAt = Date.now();
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message?.type === 'snapshot' && message.zone === 'field') {
      if (Array.isArray(message.monsters) && message.monsters.length) {
        bridge?.setSharedMonsters?.(message.monsters);
      }
      return;
    }
    if (message?.type === 'reward') {
      bridge?.awardSharedMob?.(message.mobId);
      return;
    }
    if (message?.type === 'player_damage') {
      bridge?.applySharedPlayerDamage?.(message);
    }
  }

  function connect() {
    if (!session?.access_token || !config.worldServerUrl || socket) return;
    let nextSocket;
    try {
      nextSocket = new WebSocket(
        websocketUrl(config.worldServerUrl, sessionId),
        [PROTOCOL, `auth.${session.access_token}`],
      );
    } catch {
      retryAt = Date.now() + retryDelay;
      retryDelay = Math.min(10_000, retryDelay * 1.8);
      return;
    }
    socket = nextSocket;
    nextSocket.addEventListener('open', () => {
      if (socket !== nextSocket) return;
      retryDelay = 1_000;
      lastMessageAt = Date.now();
      lastSentAt = 0;
      lastSentKey = '';
      publishConnection(true);
      sendPosition(bridge?.getSharedWorldPlayer?.() || {});
    });
    nextSocket.addEventListener('message', onMessage);
    nextSocket.addEventListener('close', () => {
      if (socket !== nextSocket) return;
      socket = null;
      publishConnection(false);
      retryAt = Date.now() + retryDelay;
      retryDelay = Math.min(10_000, retryDelay * 1.8);
    });
    nextSocket.addEventListener('error', () => {
      if (socket === nextSocket) nextSocket.close();
    });
  }

  function send(payload) {
    if (!connected || socket?.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  function sendPosition(snapshot) {
    if (!snapshot?.active || snapshot.zone !== 'field') return;
    const now = Date.now();
    const key = [
      Math.round(finite(snapshot.x) * 100),
      Math.round(finite(snapshot.y) * 100),
      Boolean(snapshot.dead),
      Math.trunc(finite(snapshot.defense)),
      Math.round(finite(snapshot.dodge) * 1_000),
    ].join('|');
    const changed = key !== lastSentKey;
    if (now - lastSentAt < (changed ? POSITION_INTERVAL_MS : IDLE_HEARTBEAT_MS)) return;
    lastSentAt = now;
    lastSentKey = key;
    send({
      type: 'player',
      x: finite(snapshot.x),
      y: finite(snapshot.y),
      dead: Boolean(snapshot.dead),
      defense: Math.max(0, Math.trunc(finite(snapshot.defense))),
      dodge: Math.max(0, finite(snapshot.dodge)),
    });
  }

  function tick() {
    const snapshot = bridge?.getSharedWorldPlayer?.();
    const shouldConnect = Boolean(
      session?.access_token
      && snapshot?.active
      && snapshot.zone === 'field'
      && !document.hidden
      && config.worldServerUrl
    );
    if (!shouldConnect) {
      if (socket) closeSocket(false);
      return;
    }
    if (!socket && Date.now() >= retryAt) connect();
    if (connected && Date.now() - lastMessageAt > 10_000) {
      closeSocket(true);
      return;
    }
    if (connected) sendPosition(snapshot);
  }

  async function setAccount(nextSession, nextProfile = profile) {
    const oldToken = session?.access_token || '';
    session = nextSession || null;
    profile = nextProfile || null;
    if (!timer) timer = window.setInterval(tick, LOOP_INTERVAL_MS);
    if (!session || oldToken !== (session.access_token || '')) closeSocket(Boolean(session));
    tick();
  }

  function hit({ mobId, damage, crit = false, kind = 'melee' }) {
    return send({
      type: 'hit',
      mobId: String(mobId || ''),
      damage: Math.max(1, Math.trunc(finite(damage, 1))),
      crit: Boolean(crit),
      kind,
    });
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) closeSocket(false);
    else tick();
  });
  window.addEventListener('pagehide', () => closeSocket(false));

  return {
    setAccount,
    hit,
    isConnected: () => connected,
    stop: () => {
      if (timer) window.clearInterval(timer);
      timer = 0;
      closeSocket(false);
    },
  };
}
