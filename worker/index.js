const PROTOCOL = 'enma-world-v1';
const ROOM_NAME = 'field-v1';
const TICK_MS = 100;
// 差分だけを送りつつ、移動は10fpsで届かせて補間の遅れを抑える。
const SNAPSHOT_MS = 100;
const RESPAWN_MS = 45_000;
const RESPAWN_NEARBY_RADIUS = 5;
const RESPAWN_RETRY_MS = 5_000;
const RESPAWN_FORCE_MS = 90_000;
const WORLD_VERSION = 1;
const PLAYER_LIMIT = 80;

const ALLOWED_ORIGINS = new Set([
  'https://enmacho-online.pages.dev',
  'https://aji42074567-stack.github.io',
  'http://127.0.0.1:8765',
  'http://localhost:8765',
]);

const DEFINITIONS = {
  goblin: {
    name: 'ガキ', hp: 30, damage: [3, 6], speed: 1.7, aggro: 0, attackCooldown: 1.7,
  },
  goblin_red: {
    name: 'アカガキ', hp: 70, damage: [8, 13], speed: 1.9, aggro: 3.8, attackCooldown: 1.6,
  },
  wolf: {
    name: 'イヌガミ', hp: 55, damage: [6, 10], speed: 2.4, aggro: 4.5, attackCooldown: 1.5,
  },
  orc: {
    name: 'アッキ', hp: 95, damage: [10, 16], speed: 1.9, aggro: 4.2, attackCooldown: 1.9,
  },
  skeleton: {
    name: 'ガシャドクロ', hp: 150, damage: [14, 22], speed: 1.6, aggro: 4, attackCooldown: 1.8,
  },
};

const SPAWNS = [
  ['goblin', 29, 31], ['goblin', 31, 30], ['goblin', 34, 31],
  ['goblin', 28, 34], ['goblin', 32, 35], ['goblin', 35, 34],
  ['goblin_red', 36, 34], ['goblin_red', 40, 36],
  ['wolf', 39, 28], ['wolf', 43, 28], ['wolf', 39, 32], ['wolf', 44, 33],
  ['wolf', 20, 32], ['wolf', 24, 32], ['wolf', 20, 36], ['wolf', 24, 36],
  ['orc', 40, 15], ['orc', 44, 15], ['orc', 42, 19],
  ['orc', 14, 22], ['orc', 18, 22], ['orc', 16, 27],
  ['skeleton', 14, 9], ['skeleton', 18, 9], ['skeleton', 16, 14],
];

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const randomInt = (min, max) => Math.floor(min + Math.random() * (max - min + 1));

function cleanText(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function islandDistance(x, y) {
  const dx = x - 31;
  const dy = y - 32;
  const theta = Math.atan2(dy, dx);
  const radius = 29.6
    + Math.sin(theta * 2.3 + 1.7)
    + Math.sin(theta * 4.7 + 0.6) * 0.7
    + Math.sin(theta * 1.1 + 4) * 0.6;
  return Math.max(Math.abs(dx), Math.abs(dy)) - radius;
}

function onIsland(x, y) {
  return x >= 2 && y >= 2 && x <= 69 && y <= 69 && islandDistance(x, y) <= 1.7;
}

function initialMobs() {
  return SPAWNS.map(([type, x, y], index) => {
    const definition = DEFINITIONS[type];
    return {
      id: `field-${index}`,
      type,
      x,
      y,
      homeX: x,
      homeY: y,
      hp: definition.hp,
      maxHp: definition.hp,
      dead: false,
      respawnAt: 0,
      forceRespawnAt: 0,
      state: 'idle',
      targetId: '',
      nextAttackAt: 0,
      strikeAt: 0,
      swingUntil: 0,
      wanderAt: Date.now() + randomInt(1_000, 4_000),
      wanderX: x,
      wanderY: y,
      face: 1,
      moving: false,
    };
  });
}

function publicMonster(monster, now) {
  return {
    id: monster.id,
    type: monster.type,
    x: Math.round(monster.x * 100) / 100,
    y: Math.round(monster.y * 100) / 100,
    hp: monster.hp,
    maxHp: monster.maxHp,
    dead: monster.dead,
    respawn: monster.dead ? Math.max(0, (monster.respawnAt - now) / 1_000) : 0,
    state: monster.state,
    moving: monster.moving,
    face: monster.face,
    swing: Math.max(0, (monster.swingUntil - now) / 1_000),
  };
}

function parseProtocols(request) {
  return (request.headers.get('Sec-WebSocket-Protocol') || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
}

function originAllowed(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return false;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  return /^https:\/\/[a-z0-9-]+\.enmacho-online\.pages\.dev$/.test(origin);
}

async function authenticate(request, env) {
  const protocols = parseProtocols(request);
  const authProtocol = protocols.find(value => value.startsWith('auth.'));
  if (!protocols.includes(PROTOCOL) || !authProtocol) return null;
  const token = authProtocol.slice(5);
  if (!token || token.length > 4_096) return null;

  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: env.SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) return null;
  const user = await response.json();
  if (!user?.id) return null;
  return {
    userId: String(user.id),
    displayName: cleanText(user.user_metadata?.display_name, 16) || 'ナナシ',
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return Response.json({
        ok: true,
        service: 'enmacho-world',
        version: WORLD_VERSION,
        respawnSeconds: RESPAWN_MS / 1_000,
      });
    }
    if (url.pathname !== '/world/field') return new Response('Not found', { status: 404 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket upgrade required', { status: 426 });
    }
    if (!originAllowed(request)) return new Response('Origin not allowed', { status: 403 });

    const identity = await authenticate(request, env);
    if (!identity) return new Response('Unauthorized', { status: 401 });

    const roomId = env.WORLD_ROOMS.idFromName(ROOM_NAME);
    const headers = new Headers(request.headers);
    headers.set('x-enma-user-id', identity.userId);
    headers.set('x-enma-display-name', identity.displayName);
    headers.set('x-enma-session-id', cleanText(url.searchParams.get('session'), 96));
    return env.WORLD_ROOMS.get(roomId).fetch(new Request(request, { headers }));
  },
};

export class WorldRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.mobs = initialMobs();
    this.timer = null;
    this.lastTickAt = Date.now();
    this.lastSnapshotAt = 0;
    this.lastPersistAt = 0;
    this.hitWindows = new Map();
    this.lastBroadcastState = new Map();
    this.ready = state.blockConcurrencyWhile(async () => {
      const saved = await state.storage.get('world');
      if (saved?.version === WORLD_VERSION && Array.isArray(saved.mobs)
        && saved.mobs.length === SPAWNS.length) {
        this.mobs = saved.mobs;
      }
      this.reconcileRespawns(Date.now());
    });
  }

  async fetch(request) {
    await this.ready;
    const sockets = this.state.getWebSockets();
    if (sockets.length >= PLAYER_LIMIT) return new Response('Room full', { status: 503 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const userId = cleanText(request.headers.get('x-enma-user-id'), 64);
    const sessionId = cleanText(request.headers.get('x-enma-session-id'), 96)
      || crypto.randomUUID();
    server.serializeAttachment({
      clientId: `${userId}:${sessionId}`,
      userId,
      displayName: cleanText(request.headers.get('x-enma-display-name'), 16) || 'ナナシ',
      x: 32,
      y: 50,
      dead: false,
      defense: 0,
      dodge: 0,
      lastSeenAt: Date.now(),
    });
    this.state.acceptWebSocket(server);
    this.send(server, this.snapshot(Date.now(), true));
    this.startTicking();
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { 'Sec-WebSocket-Protocol': PROTOCOL },
    });
  }

  webSocketMessage(socket, message) {
    if (typeof message !== 'string' || message.length > 4_096) return;
    let data;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }
    if (data?.type === 'player') this.updatePlayer(socket, data);
    if (data?.type === 'hit') this.hitMonster(socket, data);
  }

  webSocketClose(socket) {
    const attachment = socket.deserializeAttachment?.();
    if (attachment?.clientId) this.hitWindows.delete(attachment.clientId);
    socket.close(1000, 'Closed');
    if (this.state.getWebSockets().length === 0) void this.persist();
  }

  webSocketError(socket) {
    const attachment = socket.deserializeAttachment?.();
    if (attachment?.clientId) this.hitWindows.delete(attachment.clientId);
    socket.close(1011, 'Socket error');
    if (this.state.getWebSockets().length === 0) void this.persist();
  }

  updatePlayer(socket, data) {
    const attachment = socket.deserializeAttachment?.();
    if (!attachment) return;
    const x = clamp(finite(data.x, attachment.x), 2, 69);
    const y = clamp(finite(data.y, attachment.y), 2, 69);
    if (!onIsland(x, y)) return;
    socket.serializeAttachment({
      ...attachment,
      x,
      y,
      dead: Boolean(data.dead),
      defense: clamp(Math.trunc(finite(data.defense)), 0, 500),
      dodge: clamp(finite(data.dodge), 0, 0.3),
      lastSeenAt: Date.now(),
    });
  }

  hitMonster(socket, data) {
    const player = socket.deserializeAttachment?.();
    if (!player || player.dead) return;
    const monster = this.mobs.find(candidate => candidate.id === data.mobId);
    if (!monster || monster.dead) return;

    // 通常の位置通知を待たず、攻撃した瞬間の座標で射程を判定する。
    // 低速回線やスマホでも古い座標を理由に攻撃が消えないようにする。
    const hitX = clamp(finite(data.x, player.x), 2, 69);
    const hitY = clamp(finite(data.y, player.y), 2, 69);
    if (onIsland(hitX, hitY)) {
      player.x = hitX;
      player.y = hitY;
      player.lastSeenAt = Date.now();
      socket.serializeAttachment(player);
    }

    const now = Date.now();
    const hitWindow = (this.hitWindows.get(player.clientId) || [])
      .filter(timestamp => now - timestamp < 1_000);
    if (hitWindow.length >= 12) return;
    hitWindow.push(now);
    this.hitWindows.set(player.clientId, hitWindow);

    const kind = data.kind === 'melee' ? 'melee' : data.kind === 'fire' ? 'fire' : 'bolt';
    const range = kind === 'melee' ? 3.4 : 10;
    if (distance(player, monster) > range) return;
    const damage = clamp(Math.trunc(finite(data.damage)), 1, 500);
    monster.hp = Math.max(0, monster.hp - damage);
    monster.targetId = player.clientId;
    monster.state = 'chase';

    if (monster.hp === 0) {
      monster.dead = true;
      monster.respawnAt = now + RESPAWN_MS;
      monster.forceRespawnAt = now + RESPAWN_FORCE_MS;
      monster.targetId = '';
      monster.state = 'dead';
      monster.moving = false;
      this.send(socket, { type: 'reward', mobId: monster.id });
      void this.persist();
    }
    this.broadcast(this.snapshot(now));
  }

  startTicking() {
    if (this.timer) return;
    this.lastTickAt = Date.now();
    const run = () => {
      this.timer = null;
      const sockets = this.state.getWebSockets();
      if (sockets.length === 0) {
        void this.persist();
        return;
      }
      const now = Date.now();
      const dt = Math.min(0.25, Math.max(0.01, (now - this.lastTickAt) / 1_000));
      this.lastTickAt = now;
      this.tickWorld(now, dt, sockets);
      if (now - this.lastSnapshotAt >= SNAPSHOT_MS) {
        this.lastSnapshotAt = now;
        this.broadcast(this.snapshot(now), sockets);
      }
      if (now - this.lastPersistAt >= 5_000) void this.persist(now);
      this.timer = setTimeout(run, TICK_MS);
    };
    this.timer = setTimeout(run, TICK_MS);
  }

  tickWorld(now, dt, sockets) {
    const players = new Map();
    for (const socket of sockets) {
      const player = socket.deserializeAttachment?.();
      if (player && now - player.lastSeenAt < 10_000) players.set(player.clientId, { socket, ...player });
    }

    for (const monster of this.mobs) {
      monster.moving = false;
      if (monster.dead) {
        if (now >= monster.respawnAt) {
          const home = { x: monster.homeX, y: monster.homeY };
          const playerNearby = [...players.values()]
            .some(player => !player.dead && distance(home, player) < RESPAWN_NEARBY_RADIUS);
          const forceRespawnAt = finite(monster.forceRespawnAt, 0);
          if (playerNearby && now < forceRespawnAt) {
            monster.respawnAt = Math.min(forceRespawnAt, now + RESPAWN_RETRY_MS);
          } else {
            this.respawn(monster, now);
          }
        }
        continue;
      }
      const definition = DEFINITIONS[monster.type];
      let target = players.get(monster.targetId);
      if (!target || target.dead) {
        monster.targetId = '';
        target = null;
        if (monster.state === 'chase') monster.state = 'return';
      }

      if (!target && monster.state === 'idle' && definition.aggro > 0) {
        let closest = null;
        let closestDistance = definition.aggro;
        for (const player of players.values()) {
          if (player.dead) continue;
          const candidateDistance = distance(monster, player);
          if (candidateDistance < closestDistance) {
            closest = player;
            closestDistance = candidateDistance;
          }
        }
        if (closest) {
          target = closest;
          monster.targetId = closest.clientId;
          monster.state = 'chase';
        }
      }

      if (monster.strikeAt && now >= monster.strikeAt) {
        monster.strikeAt = 0;
        target = players.get(monster.targetId);
        if (target && !target.dead && distance(monster, target) <= 2.2) {
          this.strike(monster, definition, target);
        }
      }

      if (monster.state === 'chase' && target) {
        const targetDistance = distance(monster, target);
        if (targetDistance <= 1.6) {
          if (!monster.strikeAt && now >= monster.nextAttackAt) {
            monster.strikeAt = now + 220;
            monster.swingUntil = now + 350;
            monster.nextAttackAt = now + definition.attackCooldown * 1_000;
          }
        } else {
          this.moveToward(monster, target.x, target.y, definition.speed, dt);
        }
        continue;
      }

      if (monster.state === 'return') {
        if (Math.hypot(monster.x - monster.homeX, monster.y - monster.homeY) < 0.25) {
          monster.x = monster.homeX;
          monster.y = monster.homeY;
          monster.hp = monster.maxHp;
          monster.state = 'idle';
          monster.wanderAt = now + randomInt(2_000, 6_000);
        } else {
          this.moveToward(monster, monster.homeX, monster.homeY, definition.speed, dt);
        }
        continue;
      }

      if (now >= monster.wanderAt) {
        monster.wanderAt = now + randomInt(2_000, 6_000);
        if (Math.random() < 0.6) {
          monster.wanderX = monster.homeX + randomInt(-3, 3);
          monster.wanderY = monster.homeY + randomInt(-3, 3);
        } else {
          monster.wanderX = monster.x;
          monster.wanderY = monster.y;
        }
      }
      if (Math.hypot(monster.x - monster.wanderX, monster.y - monster.wanderY) > 0.2) {
        this.moveToward(monster, monster.wanderX, monster.wanderY, definition.speed * 0.65, dt);
      }
    }
  }

  strike(monster, definition, target) {
    if (Math.random() < target.dodge) {
      this.send(target.socket, { type: 'player_damage', mobId: monster.id, dodge: true });
      return;
    }
    if (Math.random() < 0.06) {
      this.send(target.socket, { type: 'player_damage', mobId: monster.id, miss: true });
      return;
    }
    const damage = Math.max(1, randomInt(...definition.damage) - target.defense);
    this.send(target.socket, { type: 'player_damage', mobId: monster.id, damage });
  }

  moveToward(monster, targetX, targetY, speed, dt) {
    const dx = targetX - monster.x;
    const dy = targetY - monster.y;
    const length = Math.hypot(dx, dy);
    if (length < 0.001) return;
    const step = Math.min(length, speed * dt);
    const nextX = monster.x + dx / length * step;
    const nextY = monster.y + dy / length * step;
    if (onIsland(nextX, nextY)) {
      monster.x = nextX;
      monster.y = nextY;
    } else if (onIsland(nextX, monster.y)) {
      monster.x = nextX;
    } else if (onIsland(monster.x, nextY)) {
      monster.y = nextY;
    }
    monster.face = dx >= 0 ? 1 : -1;
    monster.moving = true;
  }

  respawn(monster, now) {
    monster.x = monster.homeX;
    monster.y = monster.homeY;
    monster.hp = monster.maxHp;
    monster.dead = false;
    monster.respawnAt = 0;
    monster.forceRespawnAt = 0;
    monster.targetId = '';
    monster.state = 'idle';
    monster.strikeAt = 0;
    monster.swingUntil = 0;
    monster.wanderAt = now + randomInt(1_000, 4_000);
  }

  reconcileRespawns(now) {
    for (const monster of this.mobs) {
      if (monster.dead && now >= monster.respawnAt) this.respawn(monster, now);
    }
  }

  snapshot(now = Date.now(), full = false) {
    const monsters = [];
    for (const monster of this.mobs) {
      const stateKey = [
        Math.round(monster.x * 100),
        Math.round(monster.y * 100),
        monster.hp,
        monster.dead ? 1 : 0,
        monster.dead ? Math.ceil(Math.max(0, monster.respawnAt - now) / 1_000) : 0,
        monster.state,
        monster.moving ? 1 : 0,
        monster.face,
        monster.swingUntil > now ? 1 : 0,
      ].join('|');
      if (full || this.lastBroadcastState.get(monster.id) !== stateKey) {
        monsters.push(publicMonster(monster, now));
        this.lastBroadcastState.set(monster.id, stateKey);
      }
    }
    return {
      type: 'snapshot',
      zone: 'field',
      serverTime: now,
      full,
      monsters,
    };
  }

  send(socket, payload) {
    try {
      socket.send(JSON.stringify(payload));
    } catch {
      try { socket.close(1011, 'Send failed'); } catch {}
    }
  }

  broadcast(payload, sockets = this.state.getWebSockets()) {
    const serialized = JSON.stringify(payload);
    for (const socket of sockets) {
      try {
        socket.send(serialized);
      } catch {
        try { socket.close(1011, 'Send failed'); } catch {}
      }
    }
  }

  async persist(now = Date.now()) {
    this.lastPersistAt = now;
    await this.state.storage.put('world', {
      version: WORLD_VERSION,
      mobs: this.mobs,
      savedAt: now,
    });
  }
}
