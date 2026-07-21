const config = window.ENMA_ONLINE_CONFIG || {};
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

const state = {
  client: null,
  session: null,
  stats: {},
  users: [],
  settings: null,
  campaigns: [],
  presence: null,
  online: [],
  system: {
    database: 'checking',
    world: { status: 'checking', detail: '確認中' },
    summary: {},
    events: [],
  },
  busy: false,
};

const dateText = value => {
  const date = new Date(value || 0);
  if (!Number.isFinite(date.getTime())) return '—';
  return date.toLocaleString('ja-JP', {
    year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
};

const zoneName = zone => ({
  field: '賽の森', cave: '試練の洞窟', cave2: '試練の洞窟 二層', cave3: '試練の洞窟 三層',
  dg1: '竜の洞窟 一層', dg2: '竜の洞窟 二層', dg3: '竜の洞窟 三層',
  dg4: '竜の洞窟 四層', dg5: '竜の洞窟 最深部',
}[zone] || zone || '不明');

function feedback(id, message = '', error = false) {
  const host = $(id);
  if (!host) return;
  host.innerHTML = message
    ? `<div class="feedback ${error ? 'error' : ''}">${esc(message)}</div>` : '';
}

function setBusy(busy) {
  state.busy = busy;
  for (const button of document.querySelectorAll('button')) button.disabled = busy;
}

async function runBusy(action, feedbackId = 'globalFeedback') {
  if (state.busy) return null;
  setBusy(true);
  feedback(feedbackId);
  try {
    return await action();
  } catch (error) {
    feedback(feedbackId, error?.message || '処理に失敗しました', true);
    return null;
  } finally {
    setBusy(false);
  }
}

function renderMetrics() {
  const users = new Set(state.online.map(person => person.userId).filter(Boolean));
  const values = [
    ['現在接続', users.size, '人', 'online'],
    ['接続端末', state.online.length, '台', 'online'],
    ['登録魂籍', state.stats.registered ?? '—', '件'],
    ['24時間の新規', state.stats.registered24h ?? '—', '件'],
    ['24時間の接続', state.stats.active24h ?? '—', '人'],
    ['メール希望者', state.stats.newsletterOptIn ?? '—', '人'],
  ];
  $('metrics').innerHTML = values.map(([label, value, unit, className = '']) =>
    `<div class="metric panel ${className}"><span>${label}</span><b>${esc(value)}</b><small>${unit}</small></div>`
  ).join('');
}

function readPresence() {
  if (!state.presence) return [];
  const rows = Object.values(state.presence.presenceState() || {}).flat();
  const bySession = new Map();
  for (const row of rows) {
    const sessionId = String(row?.sessionId || '');
    if (!sessionId) continue;
    bySession.set(sessionId, {
      sessionId,
      userId: String(row.userId || ''),
      displayName: String(row.displayName || 'ナナシ').slice(0, 16),
      level: Math.max(1, Number(row.level) || 1),
      zone: String(row.zone || ''),
    });
  }
  return [...bySession.values()].sort((a, b) => a.displayName.localeCompare(b.displayName, 'ja'));
}

function renderOnline() {
  const unique = new Set(state.online.map(person => person.userId).filter(Boolean)).size;
  $('onlineSummary').innerHTML = `<b style="color:var(--cyan)">${unique}人</b>・${state.online.length}端末が現世接続中`;
  $('onlineList').innerHTML = state.online.length ? state.online.map(person =>
    `<div class="online-person"><b><i class="dot"></i>${esc(person.displayName)}</b>
      <small>徳位${esc(person.level)}・${esc(zoneName(person.zone))}</small></div>`
  ).join('') : '<div class="empty">現在接続している登録者はいません</div>';
  renderMetrics();
}

const sourceLabel = source => ({
  world: '共有魔物', account: '魂籍', presence: '同時接続', chat: 'チャット',
  cloud_save: 'クラウド保存', email: 'メール', client: 'ゲーム端末',
}[source] || source || '不明');

const severityLabel = severity => ({
  info: '情報', warning: '警告', error: '異常', critical: '重大',
}[severity] || '警告');

function renderSystemHealth() {
  const system = state.system;
  const summary = system.summary || {};
  const events1h = Number(summary.events1h) || 0;
  const events24h = Number(summary.events24h) || 0;
  const errors24h = Number(summary.errors24h) || 0;
  const isDown = system.database === 'down' || system.world.status === 'down';
  const hasWarning = isDown || events1h > 0 || errors24h > 0;
  const live = $('systemLive');
  live.classList.toggle('warn', hasWarning && !isDown);
  live.classList.toggle('down', isDown);
  $('systemLiveLabel').textContent = isDown ? '異常を検知' : hasWarning ? '要確認' : '正常稼働';
  document.title = hasWarning ? `【要確認】閻魔庁 運営台帳` : '閻魔庁 運営台帳';

  const databaseStatus = system.database === 'ok'
    ? ['ok', '正常', '管理DBへ接続済み']
    : system.database === 'down'
      ? ['down', '応答なし', system.databaseDetail || '監視情報を取得できません']
      : ['warn', '確認中', '応答を待っています'];
  const worldStatus = system.world.status === 'ok'
    ? ['ok', '正常', system.world.detail || '共有魔物サーバー稼働中']
    : system.world.status === 'down'
      ? ['down', '応答なし', system.world.detail || '接続できません']
      : ['warn', '確認中', '応答を待っています'];
  const eventStatus = errors24h > 0
    ? ['down', `${errors24h}件`, '24時間以内のエラー・重大']
    : events1h > 0
      ? ['warn', `${events1h}件`, '1時間以内の警告']
      : ['ok', '異常なし', '直近1時間'];
  $('systemHealth').innerHTML = [
    ['魂籍・監視DB', ...databaseStatus],
    ['共有魔物サーバー', ...worldStatus],
    ['プレイ中の異常', ...eventStatus],
  ].map(([label, className, value, detail]) =>
    `<div class="system-card ${className}"><span>${esc(label)}</span><b>${esc(value)}</b><small>${esc(detail)}</small></div>`
  ).join('');

  const alertClass = isDown ? 'down' : hasWarning ? 'warn' : '';
  const alertText = isDown
    ? '現在応答のないサービスがあります。下の状態と直近記録を確認してください。'
    : hasWarning
      ? '現在のサービスは応答していますが、直近に通信警告が記録されています。'
      : '現在、検知している異常はありません。';
  $('systemAlert').innerHTML = `<div class="system-alert ${alertClass}">${esc(alertText)}</div>`;
  $('eventSummary').textContent = `1時間 ${events1h}件・24時間 ${events24h}件・影響 ${Number(summary.affectedUsers24h) || 0}人`;

  $('systemEvents').innerHTML = system.events.length ? system.events.map(event => {
    const detail = event.details && typeof event.details === 'object' ? event.details : {};
    const parts = [sourceLabel(event.source), event.display_name || event.soul_code || '登録魂'];
    if (detail.zone) parts.push(zoneName(detail.zone));
    if (detail.closeCode) parts.push(`切断${detail.closeCode}`);
    return `<div class="event ${esc(event.severity)}">
      <span class="event-level">${esc(severityLabel(event.severity))}</span>
      <div><b>${esc(event.message)}</b><small>${esc(parts.join('・'))} / ${esc(event.code)}</small></div>
      <time>${esc(dateText(event.created_at))}</time></div>`;
  }).join('') : '<div class="empty">直近30日間の異常記録はありません</div>';
}

async function checkWorldService() {
  if (!config.worldServerUrl) throw new Error('共有サーバーURL未設定');
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 5_000);
  const startedAt = performance.now();
  try {
    const response = await fetch(`${config.worldServerUrl.replace(/\/$/, '')}/health?admin=${Date.now()}`, {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (data?.ok !== true) throw new Error('正常応答ではありません');
    return { status: 'ok', detail: `応答 ${Math.max(1, Math.round(performance.now() - startedAt))}ms` };
  } finally {
    window.clearTimeout(timeout);
  }
}

async function loadSystemHealth() {
  state.system.database = 'checking';
  state.system.world = { status: 'checking', detail: '確認中' };
  renderSystemHealth();
  const [summaryResult, eventsResult, worldResult] = await Promise.allSettled([
    state.client.rpc('admin_system_health', { p_hours: 24 }),
    state.client.rpc('admin_list_system_events', { p_limit: 50 }),
    checkWorldService(),
  ]);
  if (summaryResult.status === 'fulfilled' && !summaryResult.value.error
    && eventsResult.status === 'fulfilled' && !eventsResult.value.error) {
    state.system.database = 'ok';
    state.system.databaseDetail = '';
    state.system.summary = summaryResult.value.data || {};
    state.system.events = eventsResult.value.data || [];
  } else {
    const error = summaryResult.status === 'rejected' ? summaryResult.reason
      : summaryResult.value?.error || (eventsResult.status === 'rejected'
        ? eventsResult.reason : eventsResult.value?.error);
    state.system.database = 'down';
    state.system.databaseDetail = error?.message || '監視情報を取得できません';
  }
  state.system.world = worldResult.status === 'fulfilled'
    ? worldResult.value
    : { status: 'down', detail: worldResult.reason?.message || '接続できません' };
  renderSystemHealth();
}

async function connectPresence() {
  if (state.presence) {
    try { await state.client.removeChannel(state.presence); } catch {}
  }
  await state.client.realtime.setAuth(state.session.access_token);
  const channel = state.client.channel('game:zone:world', {
    config: { private: true, presence: { key: `admin-${crypto.randomUUID()}` } },
  });
  state.presence = channel;
  channel.on('presence', { event: 'sync' }, () => {
    state.online = readPresence();
    renderOnline();
  }).subscribe(status => {
    if (status === 'SUBSCRIBED') {
      state.online = readPresence();
      renderOnline();
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      feedback('globalFeedback', '同時接続情報へ接続できませんでした', true);
    }
  });
}

async function loadStats() {
  const { data, error } = await state.client.rpc('admin_dashboard_stats');
  if (error) throw error;
  state.stats = data || {};
  renderMetrics();
}

async function loadUsers(search = '') {
  const { data, error } = await state.client.rpc('admin_list_users', {
    p_search: search,
    p_limit: 100,
    p_offset: 0,
  });
  if (error) throw error;
  state.users = data || [];
  $('userRows').innerHTML = state.users.length ? state.users.map(user =>
    `<tr><td class="name">${esc(user.display_name)}</td><td class="mono">${esc(user.soul_code)}</td>
      <td>${esc(user.email)}</td><td>${esc(user.level)}</td><td>${esc(user.soul_stage)}</td>
      <td class="${user.newsletter_opt_in ? 'yes' : 'no'}">${user.newsletter_opt_in ? '希望' : '停止'}</td>
      <td>${esc(dateText(user.created_at))}</td><td>${esc(dateText(user.last_seen_at))}</td></tr>`
  ).join('') : '<tr><td colspan="8"><div class="empty">該当する登録者はいません</div></td></tr>';
}

async function loadSettings() {
  const { data, error } = await state.client.from('admin_email_settings')
    .select('*').eq('id', 1).single();
  if (error) throw error;
  state.settings = data;
  const form = $('mailSettingsForm');
  form.elements.from_name.value = data.from_name || '';
  form.elements.from_email.value = data.from_email || '';
  form.elements.test_recipient.value = data.test_recipient || '';
  form.elements.delivery_enabled.checked = data.delivery_enabled === true;
}

const statusLabel = status => ({
  draft: '下書き', sending: '送信処理中', submitted: 'Resend受付済み', failed: '失敗',
}[status] || status);

function renderCampaigns() {
  $('campaignList').innerHTML = state.campaigns.length ? state.campaigns.map(campaign =>
    `<div class="campaign"><div><b>${esc(campaign.name)}</b><small>${esc(dateText(campaign.updated_at))}・対象${esc(campaign.target_count || 0)}人<br><span class="status ${esc(campaign.status)}">${esc(statusLabel(campaign.status))}</span></small></div>
      <button class="btn ghost small" data-campaign="${esc(campaign.id)}">${campaign.status === 'submitted' ? '複製' : '編集'}</button></div>`
  ).join('') : '<div class="empty">配信原稿はまだありません</div>';
  for (const button of $('campaignList').querySelectorAll('[data-campaign]')) {
    button.addEventListener('click', () => selectCampaign(button.dataset.campaign));
  }
}

async function loadCampaigns() {
  const { data, error } = await state.client.from('email_campaigns').select('*')
    .order('created_at', { ascending: false }).limit(50);
  if (error) throw error;
  state.campaigns = data || [];
  renderCampaigns();
}

function resetCampaign(values = {}) {
  const form = $('campaignForm');
  form.reset();
  form.elements.id.value = '';
  form.elements.name.value = values.name || '';
  form.elements.subject.value = values.subject || '';
  form.elements.body_text.value = values.body_text || '';
  feedback('campaignFeedback');
  form.elements.name.focus();
}

function selectCampaign(id) {
  const campaign = state.campaigns.find(item => item.id === id);
  if (!campaign) return;
  const submitted = campaign.status === 'submitted';
  const form = $('campaignForm');
  form.elements.id.value = submitted ? '' : campaign.id;
  form.elements.name.value = submitted ? `${campaign.name}（複製）` : campaign.name;
  form.elements.subject.value = campaign.subject;
  form.elements.body_text.value = campaign.body_text;
  feedback('campaignFeedback', submitted ? '送信済み原稿を新しい下書きとして複製しました' : '下書きを開きました');
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function saveCampaign(silent = false) {
  const form = $('campaignForm');
  if (!form.reportValidity()) return null;
  const values = new FormData(form);
  const id = String(values.get('id') || '');
  const payload = {
    name: String(values.get('name') || '').trim(),
    subject: String(values.get('subject') || '').trim(),
    body_text: String(values.get('body_text') || '').trim(),
    status: 'draft',
    error_message: null,
  };
  let result;
  if (id) {
    result = await state.client.from('email_campaigns').update(payload)
      .eq('id', id).select('*').single();
  } else {
    result = await state.client.from('email_campaigns').insert({
      ...payload,
      created_by: state.session.user.id,
    }).select('*').single();
  }
  if (result.error) throw result.error;
  form.elements.id.value = result.data.id;
  await loadCampaigns();
  if (!silent) feedback('campaignFeedback', '下書きを保存しました');
  return result.data;
}

async function invokeNewsletter(body) {
  if (!config.adminMailFunction) throw new Error('管理メール機能が設定されていません');
  const { data, error } = await state.client.functions.invoke(config.adminMailFunction, { body });
  if (error) {
    let detail = '';
    try { detail = (await error.context?.json?.())?.error || ''; } catch {}
    throw new Error(detail || error.message || 'メール処理に失敗しました');
  }
  if (data?.error) throw new Error(data.error);
  return data || {};
}

async function refreshAll() {
  await Promise.all([loadStats(), loadUsers($('userSearch').value.trim()), loadSettings(), loadCampaigns(), loadSystemHealth()]);
  renderOnline();
}

async function openAdmin(session) {
  state.session = session;
  const { data: isAdmin, error } = await state.client.rpc('is_enma_admin');
  if (error) throw error;
  $('authPanel').classList.add('hidden');
  $('headUser').classList.remove('hidden');
  $('logoutBtn').classList.remove('hidden');
  $('adminEmail').textContent = session.user.email || '';
  if (isAdmin !== true) {
    $('forbiddenPanel').classList.remove('hidden');
    return;
  }
  $('forbiddenPanel').classList.add('hidden');
  $('adminApp').classList.remove('hidden');
  await Promise.all([refreshAll(), connectPresence()]);
}

$('loginForm').addEventListener('submit', event => {
  event.preventDefault();
  void runBusy(async () => {
    const values = new FormData(event.currentTarget);
    const { data, error } = await state.client.auth.signInWithPassword({
      email: String(values.get('email') || '').trim(),
      password: String(values.get('password') || ''),
    });
    if (error) throw error;
    await openAdmin(data.session);
  }, 'authFeedback');
});

$('logoutBtn').addEventListener('click', () => void runBusy(async () => {
  if (state.presence) await state.client.removeChannel(state.presence);
  await state.client.auth.signOut({ scope: 'local' });
  location.reload();
}));

$('refreshBtn').addEventListener('click', () => void runBusy(refreshAll));
$('refreshSystemBtn').addEventListener('click', () => void runBusy(loadSystemHealth));
$('userSearchForm').addEventListener('submit', event => {
  event.preventDefault();
  void runBusy(() => loadUsers($('userSearch').value.trim()));
});

$('mailSettingsForm').addEventListener('submit', event => {
  event.preventDefault();
  void runBusy(async () => {
    const values = new FormData(event.currentTarget);
    const { error } = await state.client.from('admin_email_settings').update({
      from_name: String(values.get('from_name') || '').trim(),
      from_email: String(values.get('from_email') || '').trim(),
      test_recipient: String(values.get('test_recipient') || '').trim(),
      delivery_enabled: values.get('delivery_enabled') === 'on',
      updated_by: state.session.user.id,
    }).eq('id', 1);
    if (error) throw error;
    await loadSettings();
    feedback('settingsFeedback', 'メール配信設定を保存しました');
  }, 'settingsFeedback');
});

$('syncAudienceBtn').addEventListener('click', () => void runBusy(async () => {
  const result = await invokeNewsletter({ action: 'sync' });
  feedback('settingsFeedback', `Resendへ${result.synced || 0}件を同期しました（配信希望 ${result.subscribed || 0}件）`);
  await loadStats();
}, 'settingsFeedback'));

$('newCampaignBtn').addEventListener('click', () => resetCampaign());
$('campaignForm').addEventListener('submit', event => {
  event.preventDefault();
  void runBusy(() => saveCampaign(), 'campaignFeedback');
});

$('testCampaignBtn').addEventListener('click', () => void runBusy(async () => {
  const campaign = await saveCampaign(true);
  if (!campaign) return;
  const result = await invokeNewsletter({ action: 'test', campaignId: campaign.id });
  feedback('campaignFeedback', `${result.testRecipient || '設定先'}へテスト送信しました`);
}, 'campaignFeedback'));

$('sendCampaignBtn').addEventListener('click', () => void runBusy(async () => {
  const campaign = await saveCampaign(true);
  if (!campaign) return;
  if (prompt('本配信します。確認のため「配信する」と入力してください。') !== '配信する') {
    feedback('campaignFeedback', '本配信を中止しました');
    return;
  }
  if (!confirm(`「${campaign.subject}」を配信希望者へ送ります。取り消せません。`)) return;
  const result = await invokeNewsletter({ action: 'send', campaignId: campaign.id });
  feedback('campaignFeedback', `${result.submitted || 0}人を対象にResendへ配信を受け付けました`);
  await Promise.all([loadCampaigns(), loadStats()]);
}, 'campaignFeedback'));

async function initialize() {
  if (!config.supabaseUrl || !config.supabasePublishableKey || !window.supabase?.createClient) {
    feedback('authFeedback', 'Supabase設定を読み込めませんでした', true);
    return;
  }
  state.client = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  const { data, error } = await state.client.auth.getSession();
  if (error) {
    feedback('authFeedback', error.message, true);
    return;
  }
  if (data.session) {
    await runBusy(() => openAdmin(data.session), 'authFeedback');
  }
  window.setInterval(() => {
    if (state.session && !document.hidden && !state.busy) {
      void Promise.allSettled([loadStats(), loadSystemHealth()]);
    }
  }, 60_000);
}

void initialize();
