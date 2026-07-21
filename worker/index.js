const PROTOCOL = 'enma-world-v1';
const TICK_MS = 100;
// 差分だけを送りつつ、移動は10fpsで届かせて補間の遅れを抑える。
const SNAPSHOT_MS = 100;
const RESPAWN_MS = 45_000;
const RESPAWN_NEARBY_RADIUS = 5;
const RESPAWN_RETRY_MS = 5_000;
const RESPAWN_FORCE_MS = 90_000;
const WORLD_VERSION = 2;
const PLAYER_LIMIT = 80;
const MAP = 72;
// field以外のゾーンは、最初に入ったクライアントが敵配置・壁データを渡す(zone_init)。
const VALID_ZONE = /^(field|cave|cave2|cave3|dg[1-5])$/;

const ALLOWED_ORIGINS = new Set([
  'https://enmacho.com',
  'https://www.enmacho.com',
  'https://enmacho-online.pages.dev',
  'https://aji42074567-stack.github.io',
  'http://127.0.0.1:8765',
  'http://localhost:8765',
  'http://127.0.0.1:8935',
  'http://localhost:8935',
  'http://127.0.0.1:8734',
  'http://localhost:8734',
]);

const FIELD_DEFINITIONS = {
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

const FIELD_SPAWNS = [
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

// ゴウリュウの出現枠: 偶数時0分(日本時間)を起点にした2時間窓
function evenWindowStart(now) {
  const HOUR = 3_600_000;
  const jst = now + 9 * HOUR;
  let start = Math.floor(jst / HOUR) * HOUR;
  if (Math.floor(jst / HOUR) % 2) start -= HOUR;
  return start - 9 * HOUR;
}

// クライアントの敵配置が更新されたら部屋データを差し替えるための署名
function zoneSignature(data) {
  const text = JSON.stringify([data.spawns, data.defs, data.walls]);
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  return `${text.length}-${hash.toString(16)}`;
}

function validateZoneInit(zone, data) {
  if (!data || typeof data !== 'object') return null;
  if (cleanText(data.zone, 16) !== zone) return null;

  const walls = data.walls;
  if (!Array.isArray(walls) || walls.length !== MAP) return null;
  for (const row of walls) {
    if (typeof row !== 'string' || row.length !== MAP || /[^01]/.test(row)) return null;
  }

  if (!data.defs || typeof data.defs !== 'object') return null;
  const defs = {};
  const defEntries = Object.entries(data.defs).slice(0, 16);
  for (const [type, raw] of defEntries) {
    if (!/^[a-z_]{2,24}$/.test(type) || !raw || typeof raw !== 'object') return null;
    defs[type] = {
      name: cleanText(raw.name, 16) || type,
      hp: clamp(Math.trunc(finite(raw.hp, 1)), 1, 200_000),
      damage: [
        clamp(Math.trunc(finite(raw.damage?.[0], 1)), 1, 2_000),
        clamp(Math.trunc(finite(raw.damage?.[1], 1)), 1, 2_000),
      ],
      speed: clamp(finite(raw.speed, 1.5), 0.2, 6),
      aggro: clamp(finite(raw.aggro, 0), 0, 14),
      attackCooldown: clamp(finite(raw.attackCooldown, 1.7), 0.5, 10),
    };
  }

  if (!Array.isArray(data.spawns) || !data.spawns.length || data.spawns.length > 64) return null;
  const spawns = [];
  for (const raw of data.spawns) {
    if (!raw || typeof raw !== 'object' || !defs[raw.type]) return null;
    const x = clamp(Math.round(finite(raw.x, 0)), 1, MAP - 2);
    const y = clamp(Math.round(finite(raw.y, 0)), 1, MAP - 2);
    spawns.push({
      type: raw.type,
      x,
      y,
      respawnMs: clamp(Math.trunc(finite(raw.respawnMs, RESPAWN_MS)), 5_000, 3_600_000),
      schedule: raw.schedule === 'even2h' ? 'even2h' : '',
    });
  }

  const zoneData = { zone, walls, defs, spawns };
  zoneData.sig = zoneSignature(zoneData);
  return zoneData;
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
    const zoneMatch = url.pathname.match(/^\/world\/([a-z0-9]+)$/);
    const zone = zoneMatch?.[1] || '';
    if (!VALID_ZONE.test(zone)) return new Response('Not found', { status: 404 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket upgrade required', { status: 426 });
    }
    if (!originAllowed(request)) return new Response('Origin not allowed', { status: 403 });

    const identity = await authenticate(request, env);
    if (!identity) return new Response('Unauthorized', { status: 401 });

    // fieldは既存部屋名(field-v1)を継続利用し、他ゾーンはゾーン名ごとの部屋
    const roomId = env.WORLD_ROOMS.idFromName(zone === 'field' ? 'field-v1' : `${zone}-v1`);
    const headers = new Headers(request.headers);
    headers.set('x-enma-user-id', identity.userId);
    headers.set('x-enma-display-name', identity.displayName);
    headers.set('x-enma-session-id', cleanText(url.searchParams.get('session'), 96));
    headers.set('x-enma-zone', zone);
    return env.WORLD_ROOMS.get(roomId).fetch(new Request(request, { headers }));
  },
};

export class WorldRoom {
  constructor(state) {
    this.state = state;
    this.zone = '';
    this.zoneData = null;   // field以外: {walls,defs,spawns,sig}
    this.mobs = [];
    this.timer = null;
    this.lastTickAt = Date.now();
    this.lastSnapshotAt = 0;
    this.lastPersistAt = 0;
    this.hitWindows = new Map();
    this.lastBroadcastState = new Map();
    this.ready = state.blockConcurrencyWhile(async () => {
      const saved = await state.storage.get('world');
      if (saved?.version === WORLD_VERSION) {
        this.zone = saved.zone || '';
        this.zoneData = saved.zoneData || null;
        if (Array.isArray(saved.mobs)) this.mobs = saved.mobs;
      }
      if (this.zone === 'field' && !this.mobs.length) this.mobs = this.initialMobs();
      this.reconcileRespawns(Date.now());
    });
  }

  definitions() {
    if (this.zone === 'field') return FIELD_DEFINITIONS;
    return this.zoneData?.defs || {};
  }

  spawnTable() {
    if (this.zone === 'field') {
      return FIELD_SPAWNS.map(([type, x, y]) => ({
        type, x, y, respawnMs: RESPAWN_MS, schedule: '',
      }));
    }
    return this.zoneData?.spawns || [];
  }

  walkable(x, y) {
    if (this.zone === 'field') return onIsland(x, y);
    const walls = this.zoneData?.walls;
    if (!walls) return false;
    const tx = Math.round(x);
    const ty = Math.round(y);
    if (tx < 1 || ty < 1 || tx > MAP - 2 || ty > MAP - 2) return false;
    return walls[ty][tx] === '0';
  }

  simReady() {
    return this.zone === 'field' || Boolean(this.zoneData);
  }

  initialMobs() {
    return this.spawnTable().map((spawn, index) => {
      const definition = this.definitions()[spawn.type];
      return {
        id: `${this.zone}-${index}`,
        type: spawn.type,
        x: spawn.x,
        y: spawn.y,
        homeX: spawn.x,
        homeY: spawn.y,
        hp: definition.hp,
        maxHp: definition.hp,
        dead: false,
        respawnAt: 0,
        forceRespawnAt: 0,
        respawnMs: spawn.respawnMs || RESPAWN_MS,
        schedule: spawn.schedule || '',
        killedWindow: 0,
        state: 'idle',
        targetId: '',
        nextAttackAt: 0,
        strikeAt: 0,
        swingUntil: 0,
        wanderAt: Date.now() + randomInt(1_000, 4_000),
        wanderX: spawn.x,
        wanderY: spawn.y,
        face: 1,
        moving: false,
      };
    });
  }

  async fetch(request) {
    await this.ready;
    const sockets = this.state.getWebSockets();
    if (sockets.length >= PLAYER_LIMIT) return new Response('Room full', { status: 503 });

    if (!this.zone) this.zone = cleanText(request.headers.get('x-enma-zone'), 16);
    // fieldは組み込みデータで即席可能(初回接続や旧バージョンからの移行時)
    if (this.zone === 'field' && !this.mobs.length) this.mobs = this.initialMobs();

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
    if (this.simReady()) {
      this.send(server, this.snapshot(Date.now(), true));
      this.startTicking();
    } else {
      // 部屋が空っぽ: 最初のクライアントにゾーンデータを要求する
      this.send(server, { type: 'need_init', zone: this.zone });
    }
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { 'Sec-WebSocket-Protocol': PROTOCOL },
    });
  }

  webSocketMessage(socket, message) {
    if (typeof message !== 'string' || message.length > 65_536) return;
    let data;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }
    if (data?.type === 'player') this.updatePlayer(socket, data);
    if (data?.type === 'hit') this.hitMonster(socket, data);
    if (data?.type === 'zone_init') this.applyZoneInit(data);
  }

  applyZoneInit(data) {
    if (this.zone === 'field') return;
    const zoneData = validateZoneInit(this.zone, data);
    if (!zoneData) return;
    // 既に同じ内容ならそのまま。ゲーム更新で配置が変わった時だけ部屋を作り直す
    if (this.zoneData?.sig === zoneData.sig && this.mobs.length === zoneData.spawns.length) {
      this.broadcastFull();
      return;
    }
    this.zoneData = zoneData;
    this.mobs = this.initialMobs();
    this.lastBroadcastState.clear();
    void this.persist();
    this.broadcastFull();
    this.startTicking();
  }

  broadcastFull() {
    const snapshot = this.snapshot(Date.now(), true);
    this.broadcast(snapshot);
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
    const x = clamp(finite(data.x, attachment.x), 1, MAP - 2);
    const y = clamp(finite(data.y, attachment.y), 1, MAP - 2);
    if (!this.walkable(x, y)) return;
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
    if (!this.simReady()) return;
    const player = socket.deserializeAttachment?.();
    if (!player || player.dead) return;
    const monster = this.mobs.find(candidate => candidate.id === data.mobId);
    if (!monster || monster.dead) return;

    // 通常の位置通知を待たず、攻撃した瞬間の座標で射程を判定する。
    // 低速回線やスマホでも古い座標を理由に攻撃が消えないようにする。
    const hitX = clamp(finite(data.x, player.x), 1, MAP - 2);
    const hitY = clamp(finite(data.y, player.y), 1, MAP - 2);
    if (this.walkable(hitX, hitY)) {
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
    const damage = clamp(Math.trunc(finite(data.damage)), 1, 3_000);
    monster.hp = Math.max(0, monster.hp - damage);
    monster.targetId = player.clientId;
    monster.state = 'chase';

    if (monster.hp === 0) {
      monster.dead = true;
      monster.respawnAt = now + (monster.respawnMs || RESPAWN_MS);
      monster.forceRespawnAt = now + (monster.respawnMs || RESPAWN_MS) * 2;
      if (monster.schedule === 'even2h') monster.killedWindow = evenWindowStart(now);
      monster.targetId = '';
      monster.state = 'dead';
      monster.moving = false;
      this.send(socket, { type: 'reward', mobId: monster.id });
      void this.persist();
    }
    this.broadcast(this.snapshot(now));
  }

  startTicking() {
    if (this.timer || !this.simReady()) return;
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
        if (monster.schedule === 'even2h') {
          // ゴウリュウは偶数時0分の新しい出現枠が来たら現れる
          if (evenWindowStart(now) !== monster.killedWindow) this.respawn(monster, now);
          continue;
        }
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
      const definition = this.definitions()[monster.type];
      if (!definition) continue;
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
    if (this.walkable(nextX, nextY)) {
      monster.x = nextX;
      monster.y = nextY;
    } else if (this.walkable(nextX, monster.y)) {
      monster.x = nextX;
    } else if (this.walkable(monster.x, nextY)) {
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
    monster.killedWindow = 0;
    monster.targetId = '';
    monster.state = 'idle';
    monster.strikeAt = 0;
    monster.swingUntil = 0;
    monster.wanderAt = now + randomInt(1_000, 4_000);
  }

  reconcileRespawns(now) {
    for (const monster of this.mobs) {
      if (!monster.dead) continue;
      if (monster.schedule === 'even2h') {
        if (evenWindowStart(now) !== monster.killedWindow) this.respawn(monster, now);
      } else if (now >= monster.respawnAt) {
        this.respawn(monster, now);
      }
    }
  }

  publicMonster(monster, now) {
    return {
      id: monster.id,
      type: monster.type,
      x: Math.round(monster.x * 100) / 100,
      y: Math.round(monster.y * 100) / 100,
      hp: monster.hp,
      maxHp: monster.maxHp,
      dead: monster.dead,
      respawn: monster.dead
        ? Math.max(0, ((monster.schedule === 'even2h'
          ? evenWindowStart(now) + 7_200_000 : monster.respawnAt) - now) / 1_000)
        : 0,
      state: monster.state,
      moving: monster.moving,
      face: monster.face,
      swing: Math.max(0, (monster.swingUntil - now) / 1_000),
    };
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
        monsters.push(this.publicMonster(monster, now));
        this.lastBroadcastState.set(monster.id, stateKey);
      }
    }
    return {
      type: 'snapshot',
      zone: this.zone,
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
      zone: this.zone,
      zoneData: this.zoneData,
      mobs: this.mobs,
      savedAt: now,
    });
  }
}
