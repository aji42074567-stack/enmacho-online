const LOOP_INTERVAL_MS = 100;
const POSITION_INTERVAL_MS = 150;
const IDLE_HEARTBEAT_MS = 2_000;
const CONNECT_FAILURE_REPORT_THRESHOLD = 3;
const PROTOCOL = 'enma-world-v1';
const SHARED_ZONES = new Set([
  'field', 'cave', 'cave2', 'cave3', 'dg1', 'dg2', 'dg3', 'dg4', 'dg5',
  'muen1', 'muen2', 'muen3',
]);

const newSessionId = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};

const finite = (value, fallback = 0) => Number.isFinite(Number(value))
  ? Number(value) : fallback;

function websocketUrl(baseUrl, sessionId, zone) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/world/${zone}`;
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
  let socketZone = '';
  let connectFailures = 0;
  let stopped = false;

  function reportEvent(code, message, details = {}) {
    try {
      window.dispatchEvent(new CustomEvent('enma:system-event', {
        detail: {
          source: 'world',
          code,
          severity: 'warning',
          message,
          details: {
            zone: socketZone,
            online: navigator.onLine !== false,
            ...details,
          },
        },
      }));
    } catch {}
  }

  function publishConnection(nextConnected) {
    if (connected === nextConnected) return;
    connected = nextConnected;
    bridge?.setSharedWorldConnection?.({
      connected,
      zone: connected ? socketZone : '',
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

  function onMessage(event, sourceSocket, sourceZone) {
    // 閉じた旧接続のキューに残っていた攻撃を、現在のプレイへ混ぜない。
    if (stopped || socket !== sourceSocket || socketZone !== sourceZone) return;
    lastMessageAt = Date.now();
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message?.type === 'snapshot' && message.zone === socketZone) {
      if (Array.isArray(message.monsters) && message.monsters.length) {
        bridge?.setSharedMonsters?.(message.monsters, message.zone);
      }
      return;
    }
    if (message?.type === 'need_init') {
      // このゾーンの部屋が空だった: 敵配置・壁データを渡してサーバー側シムを起こす
      const init = bridge?.getZoneInit?.(socketZone);
      if (init && init.zone === socketZone) send({ type: 'zone_init', ...init });
      return;
    }
    if (message?.type === 'dragon_respawn' && sourceZone === 'dg5') {
      bridge?.announceSharedDragonRespawn?.({
        respawnedAt: finite(message.respawnedAt, Date.now()),
      });
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

  function connect(zone) {
    if (stopped || !session?.access_token || !config.worldServerUrl || socket) return;
    socketZone = zone;
    let nextSocket;
    try {
      nextSocket = new WebSocket(
        websocketUrl(config.worldServerUrl, sessionId, zone),
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
      connectFailures = 0;
      retryDelay = 1_000;
      lastMessageAt = Date.now();
      lastSentAt = 0;
      lastSentKey = '';
      publishConnection(true);
      sendPosition(bridge?.getSharedWorldPlayer?.() || {});
    });
    nextSocket.addEventListener('message', event => onMessage(event, nextSocket, zone));
    nextSocket.addEventListener('close', event => {
      if (socket !== nextSocket) return;
      const wasConnected = connected;
      socket = null;
      publishConnection(false);
      retryAt = Date.now() + retryDelay;
      retryDelay = Math.min(10_000, retryDelay * 1.8);
      if (document.hidden) return;
      if (wasConnected) {
        reportEvent('world_socket_closed', '共有魔物サーバーとの接続が切れました', {
          closeCode: Number(event.code) || 0,
          reason: String(event.reason || '').slice(0, 80),
        });
      } else {
        connectFailures += 1;
        if (connectFailures >= CONNECT_FAILURE_REPORT_THRESHOLD) {
          reportEvent('world_connect_failed', '共有魔物サーバーへ接続できませんでした', {
            attempts: connectFailures,
            closeCode: Number(event.code) || 0,
          });
          connectFailures = 0;
        }
      }
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
    if (!snapshot?.active || snapshot.zone !== socketZone) return;
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
    if (stopped) return;
    const snapshot = bridge?.getSharedWorldPlayer?.();
    const zoneNow = SHARED_ZONES.has(snapshot?.zone) ? snapshot.zone : '';
    const shouldConnect = Boolean(
      session?.access_token
      && snapshot?.active
      && zoneNow
      && !document.hidden
      && config.worldServerUrl
    );
    if (!shouldConnect) {
      if (socket) closeSocket(false);
      return;
    }
    // ゾーン移動したら旧部屋を離れて新しい部屋へ入り直す
    if (socket && socketZone !== zoneNow) closeSocket(false);
    if (!socket && Date.now() >= retryAt) connect(zoneNow);
    if (connected && Date.now() - lastMessageAt > 10_000) {
      reportEvent('world_heartbeat_timeout', '共有魔物サーバーからの応答が途切れました', {
        silentMs: Date.now() - lastMessageAt,
      });
      closeSocket(true);
      return;
    }
    if (connected) sendPosition(snapshot);
  }

  async function setAccount(nextSession, nextProfile = profile) {
    if (stopped) return;
    const oldToken = session?.access_token || '';
    session = nextSession || null;
    profile = nextProfile || null;
    if (!timer) timer = window.setInterval(tick, LOOP_INTERVAL_MS);
    if (!session || oldToken !== (session.access_token || '')) closeSocket(Boolean(session));
    tick();
  }

  function hit({ mobId, damage, crit = false, kind = 'melee' }) {
    const snapshot = bridge?.getSharedWorldPlayer?.() || {};
    return send({
      type: 'hit',
      mobId: String(mobId || ''),
      damage: Math.max(1, Math.trunc(finite(damage, 1))),
      crit: Boolean(crit),
      kind,
      x: finite(snapshot.x),
      y: finite(snapshot.y),
    });
  }

  function handleVisibilityChange() {
    if (stopped) return;
    if (document.hidden) closeSocket(false);
    else tick();
  }
  function handlePageHide() {
    if (!stopped) closeSocket(false);
  }
  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('pagehide', handlePageHide);

  return {
    setAccount,
    hit,
    isConnected: () => connected,
    stop: () => {
      if (stopped) return;
      stopped = true;
      session = null;
      profile = null;
      if (timer) window.clearInterval(timer);
      timer = 0;
      closeSocket(false);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', handlePageHide);
    },
  };
}
