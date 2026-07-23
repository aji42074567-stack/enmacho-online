const PROTOCOL = 'enma-world-v1';
// scripts/deploy_worker.sh が --define BUILD_SHA でコミットSHAを埋め込む。
// 素の wrangler deploy だと 'unknown' になる=正規手順を踏んでいない印。
const BUILD = typeof BUILD_SHA === 'string' ? BUILD_SHA : 'unknown';
const TICK_MS = 100;
// 差分だけを送りつつ、移動は10fpsで届かせて補間の遅れを抑える。
const SNAPSHOT_MS = 100;
const RESPAWN_MS = 45_000;
const BOSS_RESPAWN_MS = 120_000;
const DRAKE_RESPAWN_MS = 30 * 60_000;
const RESPAWN_NEARBY_RADIUS = 5;
const RESPAWN_RETRY_MS = 5_000;
const RESPAWN_FORCE_MS = 90_000;
const WORLD_VERSION = 6;
const PLAYER_LIMIT = 80;
const ZONE_SIZE = 72;
const FIELD_SIZE = 120;
// field以外のゾーンは、最初に入ったクライアントが敵配置・壁データを渡す(zone_init)。
const VALID_ZONE = /^(field|cave|cave2|cave3|dg[1-5]|muen[1-3])$/;

const ALLOWED_ORIGINS = new Set([
  'https://enmacho.com',
  'https://www.enmacho.com',
  'https://enmacho-online.pages.dev',
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

const CANONICAL_ZONE_BOSSES = {
  cave3: {
    definition: {
      name: 'オニオウ', hp: 2_600, damage: [34, 52],
      speed: 2, aggro: 6, attackCooldown: 1.8,
    },
    spawn: {
      type: 'oni_king', x: 51, y: 30,
      respawnMs: BOSS_RESPAWN_MS, schedule: '',
    },
  },
  muen3: {
    definition: {
      name: 'ガシャオウ', hp: 6_800, damage: [52, 92],
      speed: 2, aggro: 6, attackCooldown: 1.9,
    },
    spawn: {
      type: 'gashao', x: 51, y: 30,
      respawnMs: BOSS_RESPAWN_MS, schedule: '',
    },
  },
  dg5: {
    definition: {
      name: 'ゴウリュウ', hp: 13_600, damage: [80, 180],
      speed: 2.1, aggro: 5, attackCooldown: 2.1,
    },
    spawn: {
      type: 'drake', x: 44, y: 30,
      respawnMs: DRAKE_RESPAWN_MS, schedule: 'dragon30m',
    },
  },
};

const FIELD_SPAWNS = [
  ['goblin', 41, 40], ['goblin', 44, 40], ['goblin', 47, 41],
  ['goblin', 42, 44], ['goblin', 45, 45], ['goblin', 48, 44],
  ['goblin_red', 50, 39], ['goblin_red', 53, 40],
  ['wolf', 49, 31], ['wolf', 53, 31], ['wolf', 50, 35], ['wolf', 55, 35],
  ['wolf', 25, 70], ['wolf', 29, 70], ['wolf', 26, 74], ['wolf', 31, 74],
  ['orc', 57, 36], ['orc', 60, 38], ['orc', 58, 42],
  ['orc', 32, 76], ['orc', 36, 77], ['orc', 34, 81],
  ['skeleton', 27, 86], ['skeleton', 31, 88], ['skeleton', 35, 87],
];

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const randomInt = (min, max) => Math.floor(min + Math.random() * (max - min + 1));

function cleanText(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

const SHIKOKU_OUTLINE = [
  [8.4,22.0],[12.9,23.1],[19.6,22.6],[22.4,27.0],[27.4,29.3],
  [32.5,29.3],[32.5,36.0],[35.8,40.5],[34.7,43.8],[36.4,45.0],
  [36.4,47.2],[25.2,54.5],[20.7,60.1],[18.5,68.5],[16.2,68.5],
  [9.0,60.6],[3.9,58.4],[-1.1,59.0],[-10.6,64.0],[-12.9,66.8],
  [-13.4,71.3],[-16.8,76.9],[-21.3,79.7],[-21.3,89.8],[-23.5,89.8],
  [-24.6,88.1],[-26.9,89.8],[-34.2,88.6],[-33.0,83.6],[-39.8,83.0],
  [-39.2,77.4],[-40.3,70.7],[-38.6,69.0],[-39.8,67.4],[-43.1,67.4],
  [-42.0,61.2],[-43.1,60.6],[-51.0,65.1],[-54.3,65.1],[-54.3,62.9],
  [-46.5,59.5],[-35.8,52.2],[-33.0,48.9],[-31.9,43.3],[-29.1,38.2],
  [-24.1,33.2],[-21.8,33.2],[-16.8,39.9],[-9.5,37.7],[-2.2,37.1],
  [-0.6,33.2],[-2.2,27.6],[2.8,27.6],
];

function segmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (!len2) return Math.hypot(px - ax, py - ay);
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1);
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

function islandDistance(x, y) {
  const u = (x - y) / 2;
  const v = (x + y) / 2;
  let inside = false;
  let minDistance = Infinity;
  for (let i = 0; i < SHIKOKU_OUTLINE.length; i += 1) {
    const a = SHIKOKU_OUTLINE[i];
    const b = SHIKOKU_OUTLINE[(i + 1) % SHIKOKU_OUTLINE.length];
    if (((a[1] > v) !== (b[1] > v))
      && u < ((b[0] - a[0]) * (v - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
    minDistance = Math.min(minDistance, segmentDistance(u, v, a[0], a[1], b[0], b[1]));
  }
  return (inside ? -1 : 1) * minDistance * Math.SQRT2;
}

function onIsland(x, y) {
  return x >= 2 && y >= 2 && x <= FIELD_SIZE - 3 && y <= FIELD_SIZE - 3
    && islandDistance(x, y) <= -4.5;
}

const FIELD_TOWN = { x0: 29, y0: 47, x1: 56, y1: 68 };
function insideFieldTown(x, y) {
  const tx = Math.round(x);
  const ty = Math.round(y);
  return tx >= FIELD_TOWN.x0 && tx <= FIELD_TOWN.x1
    && ty >= FIELD_TOWN.y0 && ty <= FIELD_TOWN.y1;
}

function validateFieldWalls(data) {
  if (!data || cleanText(data.zone, 16) !== 'field') return null;
  const walls = data.walls;
  if (!Array.isArray(walls) || walls.length !== FIELD_SIZE) return null;
  for (const row of walls) {
    if (typeof row !== 'string' || row.length !== FIELD_SIZE || /[^01]/.test(row)) return null;
  }
  const fieldData = { walls };
  fieldData.sig = zoneSignature({ walls, defs: {}, spawns: [] });
  return fieldData;
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
  if (!Array.isArray(walls) || walls.length !== ZONE_SIZE) return null;
  for (const row of walls) {
    if (typeof row !== 'string' || row.length !== ZONE_SIZE || /[^01]/.test(row)) return null;
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
  const canonicalBoss = CANONICAL_ZONE_BOSSES[zone];
  if (canonicalBoss) {
    defs[canonicalBoss.spawn.type] = { ...canonicalBoss.definition };
  }

  if (!Array.isArray(data.spawns) || !data.spawns.length || data.spawns.length > 64) return null;
  const spawns = [];
  for (const raw of data.spawns) {
    if (!raw || typeof raw !== 'object' || !defs[raw.type]) return null;
    const x = clamp(Math.round(finite(raw.x, 0)), 1, ZONE_SIZE - 2);
    const y = clamp(Math.round(finite(raw.y, 0)), 1, ZONE_SIZE - 2);
    const isDrake = zone === 'dg5' && raw.type === 'drake';
    spawns.push({
      type: raw.type,
      x,
      y,
      // 旧キャッシュのクライアントから2時間設定が届いても、サーバー側で30分へ固定する。
      respawnMs: isDrake
        ? DRAKE_RESPAWN_MS
        : clamp(Math.trunc(finite(raw.respawnMs, RESPAWN_MS)), 5_000, 3_600_000),
      schedule: isDrake ? 'dragon30m' : '',
    });
  }
  if (canonicalBoss) {
    const bossIndex = spawns.findIndex(spawn => spawn.type === canonicalBoss.spawn.type);
    if (bossIndex >= 0) spawns[bossIndex] = { ...canonicalBoss.spawn };
    else spawns.push({ ...canonicalBoss.spawn });
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

function healthResponse() {
  const headers = new Headers({
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  return Response.json({
    ok: true,
    service: 'enmacho-world',
    version: WORLD_VERSION,
    build: BUILD,
    respawnSeconds: RESPAWN_MS / 1_000,
    dragonRespawnSeconds: DRAKE_RESPAWN_MS / 1_000,
  }, { headers });
}

const roomNameForZone = zone => zone === 'field'
  ? 'field-v3'
  : zone === 'cave3' ? 'cave3-v2'
  : zone === 'muen3' ? 'muen3-v2'
  : zone === 'dg5' ? 'dg5-v6' : `${zone}-v1`;

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
      const healthZone = cleanText(url.searchParams.get('zone'), 16);
      if (CANONICAL_ZONE_BOSSES[healthZone]) {
        const roomId = env.WORLD_ROOMS.idFromName(roomNameForZone(healthZone));
        const headers = new Headers({
          'x-enma-health-inspect': '1',
          'x-enma-zone': healthZone,
        });
        return env.WORLD_ROOMS.get(roomId).fetch(new Request(request, { headers }));
      }
      return healthResponse();
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

    // 旧B5ルームの停止した復活状態を引き継がず、新しい部屋で作り直す。
    const roomName = roomNameForZone(zone);
    const roomId = env.WORLD_ROOMS.idFromName(roomName);
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
    this.pendingDragonRespawnNoticeAt = 0;
    this.fieldWalls = null;
    this.fieldWallsSig = '';
    this.ready = state.blockConcurrencyWhile(async () => {
      const saved = await state.storage.get('world');
      if (saved?.version === WORLD_VERSION) {
        this.zone = saved.zone || '';
        this.zoneData = saved.zoneData || null;
        this.fieldWalls = Array.isArray(saved.fieldWalls) ? saved.fieldWalls : null;
        this.fieldWallsSig = cleanText(saved.fieldWallsSig, 64);
        if (Array.isArray(saved.mobs)) this.mobs = saved.mobs;
        this.pendingDragonRespawnNoticeAt = Math.max(
          0, finite(saved.pendingDragonRespawnNoticeAt, 0),
        );
      }
      if (this.zone === 'field' && !this.mobs.length) this.mobs = this.initialMobs();
      const now = Date.now();
      if (this.reconcileRespawns(now)) await this.persist(now);
      await this.syncRespawnAlarm(now);
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

  walkable(x, y, forMonster = false) {
    if (this.zone === 'field') {
      if (!onIsland(x, y)) return false;
      if (!forMonster) return true;   // プレイヤーはクライアント側の門開閉と壁判定に従う
      if (insideFieldTown(x, y)) return false;
      if (!this.fieldWalls) return true;
      const tx = Math.round(x);
      const ty = Math.round(y);
      return this.fieldWalls[ty]?.[tx] === '0';
    }
    const walls = this.zoneData?.walls;
    if (!walls) return false;
    const tx = Math.round(x);
    const ty = Math.round(y);
    if (tx < 1 || ty < 1 || tx > ZONE_SIZE - 2 || ty > ZONE_SIZE - 2) return false;
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
        firstAttackerId: '',   // FA(最初に攻撃したプレイヤー)。respawn()のたびに空へ戻す
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
    if (request.headers.get('x-enma-health-inspect') === '1') {
      if (!this.zone) this.zone = cleanText(request.headers.get('x-enma-zone'), 16);
      const now = Date.now();
      if (this.reconcileRespawns(now, sockets)) await this.persist(now, true);
      const bossSpec = CANONICAL_ZONE_BOSSES[this.zone];
      const boss = bossSpec
        ? this.mobs.find(monster => monster.type === bossSpec.spawn.type)
        : null;
      const bossState = boss ? {
        type: boss.type,
        alive: !boss.dead,
        hp: boss.hp,
        maxHp: boss.maxHp,
        x: Math.round(boss.x * 100) / 100,
        y: Math.round(boss.y * 100) / 100,
        respawnSeconds: boss.dead
          ? Math.ceil(Math.max(0, boss.respawnAt - now) / 1_000)
          : 0,
        killedAt: boss.dead
          ? Math.max(0, boss.respawnAt - (boss.respawnMs || BOSS_RESPAWN_MS))
          : 0,
      } : null;
      return Response.json({
        ok: true,
        zone: this.zone,
        build: BUILD,
        initialized: this.simReady(),
        players: sockets.length,
        boss: bossState,
        drake: boss?.type === 'drake' ? bossState : null,
      }, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        },
      });
    }
    if (sockets.length >= PLAYER_LIMIT) return new Response('Room full', { status: 503 });

    if (!this.zone) this.zone = cleanText(request.headers.get('x-enma-zone'), 16);
    // fieldは組み込みデータで即席可能(初回接続や旧バージョンからの移行時)
    if (this.zone === 'field' && !this.mobs.length) this.mobs = this.initialMobs();
    // 無人中に復活時刻を越えた敵を、死亡スナップショット送信前に戻す。
    const now = Date.now();
    if (this.reconcileRespawns(now, sockets)) await this.persist(now);
    await this.syncRespawnAlarm(now);

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
      // 入室ごとに最新の地図を求める。sigが同じなら何もせず、地図が更新されていたら
      // 部屋を作り直す(古いキャッシュのクライアントが作った古い地形が残り続けるのを防ぐ)。
      this.send(server, { type: 'need_init', zone: this.zone });
      if (this.dispatchDragonRespawnNotice([server])) void this.persist(Date.now(), true);
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
    if (this.zone === 'field') {
      const fieldData = validateFieldWalls(data);
      if (!fieldData || this.fieldWallsSig === fieldData.sig) return;
      this.fieldWalls = fieldData.walls;
      this.fieldWallsSig = fieldData.sig;
      void this.persist();
      return;
    }
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
    if (this.zone === 'dg5') this.pendingDragonRespawnNoticeAt = Date.now();
    this.dispatchDragonRespawnNotice();
    void this.persist(Date.now(), true);
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
    if (this.state.getWebSockets().length === 0) void this.persist(Date.now(), true);
  }

  webSocketError(socket) {
    const attachment = socket.deserializeAttachment?.();
    if (attachment?.clientId) this.hitWindows.delete(attachment.clientId);
    socket.close(1011, 'Socket error');
    if (this.state.getWebSockets().length === 0) void this.persist(Date.now(), true);
  }

  updatePlayer(socket, data) {
    const attachment = socket.deserializeAttachment?.();
    if (!attachment) return;
    const size = this.zone === 'field' ? FIELD_SIZE : ZONE_SIZE;
    const x = clamp(finite(data.x, attachment.x), 1, size - 2);
    const y = clamp(finite(data.y, attachment.y), 1, size - 2);
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
    const size = this.zone === 'field' ? FIELD_SIZE : ZONE_SIZE;
    const hitX = clamp(finite(data.x, player.x), 1, size - 2);
    const hitY = clamp(finite(data.y, player.y), 1, size - 2);
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
    if (!monster.firstAttackerId) monster.firstAttackerId = player.userId;   // FA記録
    const damage = clamp(Math.trunc(finite(data.damage)), 1, 3_000);
    monster.hp = Math.max(0, monster.hp - damage);
    monster.targetId = player.clientId;
    monster.state = 'chase';

    if (monster.hp === 0) {
      monster.dead = true;
      monster.respawnAt = now + (monster.respawnMs || RESPAWN_MS);
      monster.forceRespawnAt = now + (monster.respawnMs || RESPAWN_MS) * 2;
      monster.targetId = '';
      monster.state = 'dead';
      monster.moving = false;
      if (monster.type === 'drake') this.pendingDragonRespawnNoticeAt = 0;
      this.send(socket, { type: 'reward', mobId: monster.id,
        firstAttackerId: monster.firstAttackerId || player.userId });
      // ルームが無人になっても復活時刻にWorkerを起こす。
      void this.persist(now, true);
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
      const respawnChanged = this.tickWorld(now, dt, sockets);
      if (now - this.lastSnapshotAt >= SNAPSHOT_MS) {
        this.lastSnapshotAt = now;
        this.broadcast(this.snapshot(now), sockets);
      }
      if (respawnChanged) {
        this.dispatchDragonRespawnNotice(sockets);
        void this.persist(now, true);
      }
      else if (now - this.lastPersistAt >= 5_000) void this.persist(now);
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

    let respawnChanged = false;
    for (const monster of this.mobs) {
      monster.moving = false;
      if (monster.dead) {
        if (this.reconcileMonsterRespawn(monster, now, players)) respawnChanged = true;
        continue;
      }
      // 旧シミュレーションですでに壁内や町へ入った敵は、元の出現地点へ戻す。
      if (this.zone === 'field' && !this.walkable(monster.x, monster.y, true)) {
        monster.x = monster.homeX;
        monster.y = monster.homeY;
        monster.targetId = '';
        monster.state = 'idle';
      }
      const definition = this.definitions()[monster.type];
      if (!definition) continue;
      let target = players.get(monster.targetId);
      if (target && this.zone === 'field' && insideFieldTown(target.x, target.y)) target = null;
      if (!target || target.dead) {
        monster.targetId = '';
        target = null;
        if (monster.state === 'chase') monster.state = 'return';
      }

      if (!target && monster.state === 'idle' && definition.aggro > 0) {
        let closest = null;
        let closestDistance = definition.aggro;
        for (const player of players.values()) {
          if (player.dead || (this.zone === 'field' && insideFieldTown(player.x, player.y))) continue;
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
          monster.returnStuckMs = 0;
          monster.wanderAt = now + randomInt(2_000, 6_000);
        } else {
          // 帰宅は直線移動なので、迷路の壁に引っかかると永遠に立ち往生する。
          // 進めない状態が4秒続いたら定位置へ瞬間帰還させる(リネ式リーシュ)。
          const beforeX = monster.x;
          const beforeY = monster.y;
          this.moveToward(monster, monster.homeX, monster.homeY, definition.speed, dt);
          const moved = Math.hypot(monster.x - beforeX, monster.y - beforeY);
          if (moved < definition.speed * dt * 0.25) {
            monster.returnStuckMs = (monster.returnStuckMs || 0) + dt * 1_000;
            if (monster.returnStuckMs >= 4_000) {
              monster.x = monster.homeX;
              monster.y = monster.homeY;
              monster.hp = monster.maxHp;
              monster.state = 'idle';
              monster.returnStuckMs = 0;
              monster.wanderAt = now + randomInt(2_000, 6_000);
            }
          } else {
            monster.returnStuckMs = 0;
          }
        }
        continue;
      }

      // 追跡ややり残しで定位置から離れすぎた敵(過去に立ち往生した個体を含む)は帰宅させる。
      if (Math.hypot(monster.x - monster.homeX, monster.y - monster.homeY) > 6) {
        monster.state = 'return';
        monster.targetId = '';
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
    return respawnChanged;
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
    if (this.walkable(nextX, nextY, true)) {
      monster.x = nextX;
      monster.y = nextY;
    } else if (this.walkable(nextX, monster.y, true)) {
      monster.x = nextX;
    } else if (this.walkable(monster.x, nextY, true)) {
      monster.y = nextY;
    }
    monster.face = dx >= 0 ? 1 : -1;
    monster.moving = true;
  }

  respawn(monster, now) {
    const announceDragon = monster.type === 'drake' && monster.dead;
    monster.x = monster.homeX;
    monster.y = monster.homeY;
    monster.hp = monster.maxHp;
    monster.dead = false;
    monster.firstAttackerId = '';
    monster.respawnAt = 0;
    monster.forceRespawnAt = 0;
    monster.killedWindow = 0;
    monster.targetId = '';
    monster.state = 'idle';
    monster.strikeAt = 0;
    monster.swingUntil = 0;
    monster.wanderAt = now + randomInt(1_000, 4_000);
    if (announceDragon) this.pendingDragonRespawnNoticeAt = now;
  }

  reconcileMonsterRespawn(monster, now, players = new Map()) {
    if (!monster.dead || now < monster.respawnAt) return false;
    if (monster.schedule === 'dragon30m') {
      // ゴウリュウは討伐から30分後、付近のプレイヤー有無にかかわらず復活する。
      this.respawn(monster, now);
      return true;
    }
    const home = { x: monster.homeX, y: monster.homeY };
    const playerNearby = [...players.values()]
      .some(player => !player.dead && distance(home, player) < RESPAWN_NEARBY_RADIUS);
    const forceRespawnAt = finite(monster.forceRespawnAt, 0);
    if (playerNearby && now < forceRespawnAt) {
      monster.respawnAt = Math.min(forceRespawnAt, now + RESPAWN_RETRY_MS);
    } else {
      this.respawn(monster, now);
    }
    return true;
  }

  reconcileRespawns(now, sockets = []) {
    const players = new Map();
    for (const socket of sockets) {
      const player = socket.deserializeAttachment?.();
      if (player && now - player.lastSeenAt < 10_000) players.set(player.clientId, player);
    }
    let changed = false;
    for (const monster of this.mobs) {
      if (this.reconcileMonsterRespawn(monster, now, players)) changed = true;
    }
    return changed;
  }

  async syncRespawnAlarm(now = Date.now()) {
    let nextRespawnAt = Infinity;
    for (const monster of this.mobs) {
      if (!monster.dead) continue;
      const respawnAt = finite(monster.respawnAt, 0);
      if (respawnAt > 0) nextRespawnAt = Math.min(nextRespawnAt, respawnAt);
    }
    const current = await this.state.storage.getAlarm();
    if (!Number.isFinite(nextRespawnAt)) {
      if (current !== null) await this.state.storage.deleteAlarm();
      return;
    }
    const target = Math.max(now + 100, nextRespawnAt);
    if (current === null || Math.abs(current - target) > 50) {
      await this.state.storage.setAlarm(target);
    }
  }

  async alarm() {
    await this.ready;
    const now = Date.now();
    const sockets = this.state.getWebSockets();
    const changed = this.reconcileRespawns(now, sockets);
    if (sockets.length) this.dispatchDragonRespawnNotice(sockets);
    await this.persist(now, true);
    if (sockets.length) {
      if (changed) this.broadcast(this.snapshot(now), sockets);
      this.startTicking();
    }
  }

  dispatchDragonRespawnNotice(sockets = this.state.getWebSockets()) {
    if (!this.pendingDragonRespawnNoticeAt || !sockets.length) return false;
    const [socket] = sockets;
    this.send(socket, {
      type: 'dragon_respawn',
      respawnedAt: this.pendingDragonRespawnNoticeAt,
    });
    this.pendingDragonRespawnNoticeAt = 0;
    return true;
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
        ? Math.max(0, (monster.respawnAt - now) / 1_000)
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

  async persist(now = Date.now(), syncAlarm = false) {
    this.lastPersistAt = now;
    await this.state.storage.put('world', {
      version: WORLD_VERSION,
      zone: this.zone,
      zoneData: this.zoneData,
      fieldWalls: this.fieldWalls,
      fieldWallsSig: this.fieldWallsSig,
      mobs: this.mobs,
      pendingDragonRespawnNoticeAt: this.pendingDragonRespawnNoticeAt,
      savedAt: now,
    });
    if (syncAlarm) await this.syncRespawnAlarm(now);
  }
}
