// ?v= は旧キャッシュを飛ばすための目印(play.html側と揃える)
import { createPresenceController } from './presence.js?v=20260722b';
import { createWorldController } from './world.js?v=20260722b';
import { createSocialController } from './social.js?v=20260722c';
import { createGuildController } from './guild.js?v=20260722b';

const config = window.ENMA_ONLINE_CONFIG || {};
const content = document.getElementById('accountContent');
const accountButton = document.getElementById('accountBtn');
const accountDot = document.getElementById('accountDot');
const accountTitle = document.getElementById('accountTitle');
const accountClose = document.getElementById('accountClose');

const importedCloudLevel = (() => {
  try {
    const level = sessionStorage.getItem('enma_cloud_import_notice');
    sessionStorage.removeItem('enma_cloud_import_notice');
    return level && /^\d+$/.test(level) ? Number(level) : null;
  } catch {
    return null;
  }
})();

const state = {
  client: null,
  session: null,
  profile: null,
  preferences: null,
  cloudSave: null,
  autoSyncState: 'checking',
  autoSyncMessage: 'クラウド記録を確認しています…',
  configured: Boolean(config.supabaseUrl && config.supabasePublishableKey),
  message: importedCloudLevel
    ? `最新のクラウド記録を自動同期しました（徳位${importedCloudLevel}）`
    : '',
  error: '',
  busy: false,
  authMode: 'login',
  sessionSource: 'initial',
  lastEmail: '',
};

let accountLoadRevision = 0;
let presenceController = null;
let worldController = null;
let socialController = null;
let guildController = null;
let cloudSaveTimer = 0;
let cloudSaveInFlight = false;
let cloudSaveQueued = false;
let cloudSaveUserId = '';
let cloudReloadTimer = 0;
const reportedSystemEvents = new Map();

async function reportSystemEvent(detail = {}, retry = false) {
  if (!state.client || !state.session?.user?.id) return;
  const source = String(detail.source || 'client').toLowerCase().slice(0, 32);
  const code = String(detail.code || 'unknown').toLowerCase().slice(0, 48);
  const key = `${source}:${code}`;
  const now = Date.now();
  if (!retry) {
    if (now - (reportedSystemEvents.get(key) || 0) < 60_000) return;
    reportedSystemEvents.set(key, now);
  }
  const severity = ['info', 'warning', 'error', 'critical'].includes(detail.severity)
    ? detail.severity : 'warning';
  try {
    const { error } = await state.client.rpc('report_client_event', {
      p_source: source,
      p_code: code,
      p_severity: severity,
      p_message: String(detail.message || code).slice(0, 160),
      p_details: detail.details && typeof detail.details === 'object' ? detail.details : {},
    });
    if (error) throw error;
  } catch {
    if (!retry) window.setTimeout(() => void reportSystemEvent(detail, true), 10_000);
  }
}

window.addEventListener('enma:system-event', event => {
  void reportSystemEvent(event.detail || {});
});

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const withTimeout = (promise, milliseconds, message) => Promise.race([
  promise,
  new Promise((_, reject) => window.setTimeout(
    () => reject(new Error(message)),
    milliseconds,
  )),
]);
const isJwtClockSkew = error => /JWT issued at future/i.test(error?.message || '');

function syncOnlineControllers(session, profile) {
  Promise.allSettled([
    presenceController?.setAccount(session, profile),
    worldController?.setAccount(session, profile),
    socialController?.setAccount(session, profile),
    guildController?.setAccount(session, profile),
  ]).catch(() => {});
}

const setFeedback = (message = '', error = '') => {
  state.message = message;
  state.error = error;
};

const friendlyError = error => {
  const message = error?.message || '処理に失敗しました';
  if (/profiles_display_name_unique|duplicate key.*display_name|魂名はすでに/i.test(message))
    return 'この魂名はすでに使われています。別の魂名を選んでください';
  if (/invalid login credentials/i.test(message))
    return 'メールアドレスまたはパスワードが違います';
  if (/email not confirmed/i.test(message))
    return 'メール確認が完了していません。確認メール内のリンクを開いてください';
  if (/user already registered/i.test(message))
    return 'このメールアドレスは登録済みです。「ログイン」から入ってください';
  if (/password should be at least/i.test(message))
    return 'パスワードは8文字以上で入力してください';
  if (/rate limit/i.test(message))
    return '試行回数が多いため一時停止中です。少し待ってからお試しください';
  return message;
};

async function assertDisplayNameAvailable(displayName) {
  const { data, error } = await state.client.rpc('is_display_name_available', {
    p_display_name: displayName,
  });
  if (error) throw new Error(`魂名の重複確認に失敗しました：${error.message}`);
  if (data !== true)
    throw new Error('この魂名はすでに使われています。別の魂名を選んでください');
}

function localSaveInfo() {
  const payload = window.EnmaGameBridge?.exportSave?.() || null;
  const ownerId = window.EnmaGameBridge?.getSaveOwner?.() || '';
  return {
    payload,
    ownerId,
    name: String(payload?.name || window.EnmaGameBridge?.getProfile?.()?.displayName || 'ナナシ'),
    level: Number(payload?.lv) || window.EnmaGameBridge?.getProfile?.()?.level || 1,
  };
}

function sameSaveIdentity(localPayload, cloudPayload) {
  if (!localPayload || !cloudPayload) return false;
  const localName = String(localPayload.name || '').trim();
  const cloudName = String(cloudPayload.name || '').trim();
  return Boolean(localName && cloudName && localName === cloudName
    && (localPayload.gender || 'm') === (cloudPayload.gender || 'm'));
}

function saveBinding() {
  const local = localSaveInfo();
  const userId = state.session?.user?.id || '';
  if (!local.payload) return { kind: 'empty', local };
  if (local.ownerId === userId) return { kind: 'match', local };
  if (local.ownerId) return { kind: 'other', local };
  return { kind: 'unclaimed', local };
}

const payloadSignature = payload => {
  try {
    if (!payload || typeof payload !== 'object') return JSON.stringify(payload || null);
    // 保存時刻だけの更新は「進行が変わった」と扱わず、不要な通信や競合を避ける。
    const { savedAt: _savedAt, ...progress } = payload;
    return JSON.stringify(progress);
  } catch { return ''; }
};

const payloadSavedAt = (payload, fallback = '') => {
  const direct = Number(payload?.savedAt);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const parsed = Date.parse(fallback || '');
  return Number.isFinite(parsed) ? parsed : 0;
};

const comparePayloadLevel = (localPayload, cloudPayload) => {
  const localLevel = Math.max(1, Math.trunc(Number(localPayload?.lv) || 1));
  const cloudLevel = Math.max(1, Math.trunc(Number(cloudPayload?.lv) || 1));
  return Math.sign(localLevel - cloudLevel);
};

function setAutoSyncState(kind, message) {
  state.autoSyncState = kind;
  state.autoSyncMessage = message;
  const status = document.getElementById('accountCloudState');
  if (status) {
    status.className = `account-sync-status ${kind}`;
    status.textContent = message;
  }
  const cloudLevel = document.getElementById('accountCloudLevel');
  if (cloudLevel) cloudLevel.textContent = state.cloudSave?.payload?.lv ?? '同期前';
}

function scheduleAccountReload(delay = 10_000) {
  window.clearTimeout(cloudReloadTimer);
  cloudReloadTimer = window.setTimeout(() => {
    cloudReloadTimer = 0;
    if (!state.client || !state.session?.user?.id) return;
    void loadAccountData().catch(error => {
      setAutoSyncState('retrying', 'クラウド記録を確認できません。通信復帰後に再試行します');
      void reportSystemEvent({
        source: 'account', code: 'cloud_autoload_failed', severity: 'warning',
        message: error?.message || 'cloud autoload failed',
      });
      scheduleAccountReload();
    });
  }, delay);
}

function bindLegacySaveIfSafe() {
  const userId = state.session?.user?.id || '';
  const local = localSaveInfo();
  if (!userId || !local.payload || local.ownerId) return;
  const cloudPayload = state.cloudSave?.payload || null;
  const safe = state.sessionSource === 'signup'
    || sameSaveIdentity(local.payload, cloudPayload)
    || (state.sessionSource === 'initial' && !cloudPayload);
  if (safe) window.EnmaGameBridge?.claimSave?.(userId);
}

const setGatewayCopy = (title, closeLabel) => {
  if (accountTitle) accountTitle.textContent = title;
  if (accountClose) accountClose.textContent = closeLabel;
};

function setButtonState(kind) {
  accountButton?.classList.toggle('online', kind === 'online');
  accountButton?.classList.toggle('pending', kind === 'pending');
  if (accountDot) accountDot.title = kind === 'online' ? 'ログイン中'
    : kind === 'pending' ? 'メール確認待ち' : '未ログイン';
}

function feedbackHtml() {
  if (state.error) return `<p class="account-feedback error">${esc(state.error)}</p>`;
  if (state.message) return `<p class="account-feedback">${esc(state.message)}</p>`;
  return '';
}

function renderUnconfigured() {
  setButtonState('offline');
  setGatewayCopy('端末記録で入庁', 'ゲーム画面へ進む');
  content.innerHTML = `
    <div class="account-seal" aria-hidden="true">準備中</div>
    <p class="account-lead">魂籍は、亡者から転生者になっても残るオンライン上の身分証です。</p>
    <div class="account-card">
      <span class="account-label">現在の状態</span>
      <b>端末内の記録で遊べます</b>
      <p>オンライン登録の接続先を設定すると、魂籍番号・クラウド保存・フレンド機能が有効になります。</p>
    </div>
    <p class="account-note">未登録のままでも第一章はこれまでどおり遊べます。</p>`;
}

function renderSignedOut() {
  const local = localSaveInfo();
  setButtonState(state.message.includes('確認メール') ? 'pending' : 'offline');
  setGatewayCopy('魂籍へログイン', 'ログインせず端末記録で続ける');
  content.innerHTML = `
    ${feedbackHtml()}
    <div class="account-device-save">
      <span>この端末の記録</span>
      <b>${local.payload ? `${esc(local.name)}・徳位${esc(local.level)}` : 'まだ記録はありません'}</b>
      <small>${local.ownerId
        ? '前回の魂籍に紐付いた記録です。別の魂籍へ誤保存されません。'
        : 'ログイン後、対応する魂籍へ安全に紐付けます。'}</small>
    </div>
    <div class="account-auth-tabs" role="tablist" aria-label="魂籍の入口">
      <button type="button" role="tab" data-auth-mode="login"
        aria-selected="${state.authMode === 'login'}"
        class="${state.authMode === 'login' ? 'on' : ''}">ログイン</button>
      <button type="button" role="tab" data-auth-mode="signup"
        aria-selected="${state.authMode === 'signup'}"
        class="${state.authMode === 'signup' ? 'on' : ''}">新規登録</button>
    </div>
    ${state.authMode === 'login' ? `
      <p class="account-lead">別端末でも、登録した魂籍のメールアドレスで入れます。</p>
      <form id="soulLoginForm" class="account-form compact">
        <label>メールアドレス
          <input name="email" type="email" required autocomplete="email"
            inputmode="email" value="${esc(state.lastEmail)}" placeholder="name@example.com">
        </label>
        <label>パスワード
          <input name="password" type="password" required autocomplete="current-password"
            placeholder="登録したパスワード">
        </label>
        <button class="buyb account-primary" type="submit" ${state.busy ? 'disabled' : ''}>
          ${state.busy ? '照合中…' : '魂籍へログイン'}</button>
        <button class="linkbtn account-reset" id="soulResetPassword" type="button">パスワードを再設定</button>
      </form>` : `
      <p class="account-lead">無料の魂籍を作ると、端末を越えて記録を残せます。</p>
      <form id="soulSignupForm" class="account-form">
        <label>魂名
          <input name="displayName" maxlength="16" required
            value="${esc(local.name)}" placeholder="ゲーム内で表示する名前"
            autocomplete="nickname" ${local.payload ? 'readonly' : ''}>
          ${local.payload
            ? '<small class="account-name-note">現在のキャラクター名で登録します（変更不可）</small>'
            : '<small class="account-name-note">一度決めた名は変更できず、他の魂籍と同じ名も使えません</small>'}
        </label>
        <label>メールアドレス
          <input name="email" type="email" required placeholder="name@example.com"
            inputmode="email" value="${esc(state.lastEmail)}" autocomplete="email">
        </label>
        <label>パスワード
          <input name="password" type="password" minlength="8" required
            placeholder="8文字以上" autocomplete="new-password">
        </label>
        <label class="account-check">
          <input name="newsletter" type="checkbox">
          <span>更新情報をメールで受け取る（いつでも解除できます）</span>
        </label>
        <button class="buyb account-primary" type="submit" ${state.busy ? 'disabled' : ''}>
          ${state.busy ? '登録中…' : '魂籍を新規登録'}</button>
      </form>`}`;

  document.getElementById('soulSignupForm')?.addEventListener('submit', signUp);
  document.getElementById('soulLoginForm')?.addEventListener('submit', signIn);
  document.getElementById('soulResetPassword')?.addEventListener('click', resetPassword);
  for (const button of content.querySelectorAll('[data-auth-mode]')) {
    button.addEventListener('click', () => {
      state.authMode = button.dataset.authMode === 'signup' ? 'signup' : 'login';
      setFeedback();
      render();
    });
  }
}

function stageLabel(stage) {
  if (stage === 'reincarnated') return '転生者';
  if (stage === 'rebirth_candidate') return '転生候補者';
  return '亡者';
}

function renderSignedIn() {
  const profile = state.profile || {};
  const localProfile = window.EnmaGameBridge?.getProfile?.() || {};
  const binding = saveBinding();
  const local = binding.local;
  const cloud = state.cloudSave;
  const bound = window.EnmaGameBridge?.getBoundSave?.(state.session?.user?.id) || null;
  const conflict = binding.kind === 'other' || binding.kind === 'unclaimed';
  setButtonState('online');
  setGatewayCopy('現在の魂籍', 'ゲーム画面へ戻る');
  content.innerHTML = `
    ${feedbackHtml()}
    <div class="account-code">
      <span>魂籍番号</span>
      <strong>${esc(profile.soul_code || '発行待ち')}</strong>
      <small>転生後も変わらないフレンド検索用の番号</small>
    </div>
    <div class="account-grid">
      <div><span>魂名</span><b>${esc(profile.display_name || 'ナナシ')}</b></div>
      <div><span>身分</span><b>${esc(stageLabel(profile.soul_stage || localProfile.soulStage))}</b></div>
      <div><span>同期中の徳位</span><b id="accountCloudLevel">${esc(cloud?.payload?.lv ?? '同期前')}</b></div>
      <div><span>メール</span><b class="account-email">${esc(state.session?.user?.email || '')}</b></div>
    </div>
    <div class="account-save-state ${conflict ? 'conflict' : 'match'}">
      <span>この端末の記録</span>
      <b>${local.payload ? `${esc(local.name)}・徳位${esc(local.level)}` : '記録なし'}</b>
      <small>${binding.kind === 'match'
        ? '現在の魂籍と一致しています。'
        : binding.kind === 'empty'
          ? 'この端末にはまだプレイ記録がありません。'
          : binding.kind === 'other'
            ? '別の魂籍に紐付いた記録です。現在の魂籍へは保存できません。'
            : 'どの魂籍の記録か未確認です。切り替え方法を選んでください。'}</small>
    </div>
    ${conflict ? `<div class="account-save-warning">
      <b>記録の混在を止めています</b>
      <p>${cloud
        ? '別の魂籍か確認できない端末記録があるため、自動同期を一時停止しています。現在の魂籍へ切り替えると自動同期を再開します。'
        : bound
          ? `この端末に「${esc(bound.name || 'ナナシ')}・徳位${esc(bound.lv || 1)}」の記録が残っています。そこへ戻せます。`
        : binding.kind === 'unclaimed'
          ? 'クラウド記録がない魂籍です。端末記録を引き継ぐか、新しい記録で始めてください。'
          : 'クラウド記録がない別魂籍です。誤上書きを防ぐため、新しい記録で始めてください。'}</p>
    </div>` : ''}
    <form id="soulProfileForm" class="account-form compact account-profile-form">
      <label class="account-check">
        <input name="newsletter" type="checkbox" ${state.preferences?.newsletter_opt_in ? 'checked' : ''}>
        <span>更新情報をメールで受け取る</span>
      </label>
      <button class="buyb" type="submit" ${state.busy ? 'disabled' : ''}>メール設定を保存</button>
    </form>
    <div class="account-divider"><span>魂の記録</span></div>
    <div class="account-cloud">
      <p id="accountCloudState" class="account-sync-status ${esc(state.autoSyncState)}">${esc(state.autoSyncMessage)}</p>
      <small>ログイン中は進行を端末とクラウドへ自動保存します。別端末では最新の記録が自動で開きます。</small>
    </div>
    ${conflict && cloud
      ? '<div class="account-switch-actions"><button class="buyb" id="cloudDownload" type="button">この魂籍の記録へ切り替える</button></div>'
      : ''}
    ${conflict && !cloud ? `<div class="account-switch-actions">
      ${bound
        ? '<button class="buyb" id="restoreBoundSave" type="button">この魂籍の端末記録へ切り替える</button>'
        : binding.kind === 'unclaimed'
        ? '<button class="buyb" id="claimLocalSave" type="button">端末記録をこの魂籍へ引き継ぐ</button>'
        : ''}
      ${bound ? '' : '<button class="linkbtn" id="startFreshSave" type="button">この魂籍を新しい記録で始める</button>'}
    </div>` : ''}
    <div class="account-divider"><span>魂籍の切り替え</span></div>
    <button class="buyb account-logout" id="soulLogout" type="button"
      ${state.busy ? 'disabled' : ''}>この端末だけログアウト</button>
    <p class="account-logout-note">他のスマホ・PCはログインしたままです。端末記録も消えません。</p>`;

  document.getElementById('soulProfileForm')?.addEventListener('submit', updateProfile);
  document.getElementById('cloudDownload')?.addEventListener('click', downloadCloudSave);
  document.getElementById('claimLocalSave')?.addEventListener('click', claimLocalSave);
  document.getElementById('restoreBoundSave')?.addEventListener('click', restoreBoundSave);
  document.getElementById('startFreshSave')?.addEventListener('click', startFreshSave);
  document.getElementById('soulLogout')?.addEventListener('click', signOut);
}

function render() {
  if (!content) return;
  if (!state.configured) return renderUnconfigured();
  if (!state.client) {
    content.innerHTML = `<p class="account-lead">魂籍台帳へ接続しています…</p>${feedbackHtml()}`;
    return;
  }
  if (!state.session) return renderSignedOut();
  return renderSignedIn();
}

async function fetchAccountData(userId) {
  const [profileResult, preferencesResult, cloudSaveResult] = await Promise.all([
    state.client.from('profiles').select('*').eq('id', userId).single(),
    state.client.from('account_preferences').select('newsletter_opt_in')
      .eq('user_id', userId).single(),
    state.client.from('game_saves').select('save_version,revision,client_updated_at,updated_at,payload')
      .eq('user_id', userId).maybeSingle(),
  ]);
  return { profileResult, preferencesResult, cloudSaveResult };
}

async function loadAccountData() {
  const revision = ++accountLoadRevision;
  if (!state.session || !state.client) {
    window.clearTimeout(cloudReloadTimer);
    cloudReloadTimer = 0;
    window.clearTimeout(cloudSaveTimer);
    cloudSaveTimer = 0;
    cloudSaveQueued = false;
    cloudSaveUserId = '';
    state.profile = null;
    state.preferences = null;
    state.cloudSave = null;
    syncOnlineControllers(null, null);
    render();
    return;
  }
  const userId = state.session.user.id;
  window.clearTimeout(cloudReloadTimer);
  cloudReloadTimer = 0;
  cloudSaveUserId = '';
  let results;
  try {
    results = await withTimeout(
      fetchAccountData(userId),
      12_000,
      '魂籍台帳からの応答に時間がかかっています',
    );
  } catch (error) {
    if (revision !== accountLoadRevision || state.session?.user?.id !== userId) return;
    state.profile = null;
    state.preferences = null;
    state.cloudSave = null;
    cloudSaveUserId = '';
    setAutoSyncState('retrying', 'クラウド記録を確認できません。通信復帰後に再試行します');
    scheduleAccountReload();
    setFeedback('', `${error.message}。ゲームはそのまま開始できます`);
    syncOnlineControllers(state.session, null);
    render();
    return;
  }
  const firstErrors = [
    results.profileResult.error,
    results.preferencesResult.error,
    results.cloudSaveResult.error,
  ].filter(Boolean);

  if (firstErrors.some(isJwtClockSkew)) {
    await wait(2500);
    if (revision !== accountLoadRevision || state.session?.user?.id !== userId) return;
    const { data, error } = await state.client.auth.refreshSession();
    if (!error && data.session) state.session = data.session;
    try {
      results = await withTimeout(
        fetchAccountData(userId),
        12_000,
        '魂籍台帳からの応答に時間がかかっています',
      );
    } catch (retryError) {
      if (revision !== accountLoadRevision || state.session?.user?.id !== userId) return;
      setFeedback('', `${retryError.message}。ゲームはそのまま開始できます`);
      setAutoSyncState('retrying', 'クラウド記録を確認できません。通信復帰後に再試行します');
      scheduleAccountReload();
      syncOnlineControllers(state.session, state.profile);
      render();
      return;
    }
  }

  if (revision !== accountLoadRevision || state.session?.user?.id !== userId) return;
  const {
    profileResult: { data: profile, error: profileError },
    preferencesResult: { data: preferences, error: preferencesError },
    cloudSaveResult: { data: cloudSave, error: saveError },
  } = results;

  if (profileError) {
    setFeedback('', isJwtClockSkew(profileError)
      ? '認証情報の時刻を同期できませんでした。数秒待ってアカウント画面を開き直してください'
      : `プロフィールを読めませんでした：${profileError.message}`);
  } else if (preferencesError) {
    setFeedback('', isJwtClockSkew(preferencesError)
      ? '認証情報の時刻を同期できませんでした。数秒待ってアカウント画面を開き直してください'
      : `メール設定を読めませんでした：${preferencesError.message}`);
  } else if (saveError) {
    cloudSaveUserId = '';
    setAutoSyncState('retrying', 'クラウド記録を確認できません。自動保存を一時停止しています');
    scheduleAccountReload();
    setFeedback('', isJwtClockSkew(saveError)
      ? '認証情報の時刻を同期できませんでした。数秒待ってアカウント画面を開き直してください'
      : `クラウド記録を確認できませんでした：${saveError.message}`);
  } else {
    cloudSaveUserId = userId;
    state.error = '';
  }
  state.profile = profile;
  state.preferences = preferences;
  state.cloudSave = cloudSave;
  if (state.profile) {
    const lastSeenAt = new Date().toISOString();
    state.profile.last_seen_at = lastSeenAt;
    void state.client.from('profiles').update({ last_seen_at: lastSeenAt })
      .eq('id', userId).then(() => {});
  }
  if (!saveError) {
    const syncReady = await reconcileCloudSave();
    if (!syncReady) return;
  }
  syncOnlineControllers(state.session, state.profile);
  render();
}

async function withBusy(action) {
  if (state.busy) return;
  state.busy = true;
  render();
  try {
    await action();
  } catch (error) {
    setFeedback('', friendlyError(error));
  } finally {
    state.busy = false;
    render();
  }
}

async function signUp(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  await withBusy(async () => {
    setFeedback();
    const email = String(form.get('email') || '').trim();
    const password = String(form.get('password') || '');
    const displayName = String(form.get('displayName') || '').normalize('NFKC').trim().slice(0, 16);
    const newsletterOptIn = form.get('newsletter') === 'on';
    state.lastEmail = email;
    await assertDisplayNameAvailable(displayName);
    const { data, error } = await state.client.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${location.origin}${location.pathname}`,
        data: { display_name: displayName, newsletter_opt_in: newsletterOptIn },
      },
    });
    if (error) {
      // 同時登録で事前確認をすり抜けても、DBの一意制約後に日本語で案内する。
      await assertDisplayNameAvailable(displayName);
      throw error;
    }
    state.session = data.session;
    state.sessionSource = 'signup';
    if (data.session) window.EnmaGameBridge?.claimSave?.(data.session.user.id);
    setFeedback(data.session
      ? '魂籍を登録しました'
      : '確認メールを送りました。メール内のリンクを開いて登録を完了してください');
    if (data.session) await loadAccountData();
  });
}

async function signIn(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  await withBusy(async () => {
    setFeedback();
    const email = String(form.get('email') || '').trim();
    state.lastEmail = email;
    const { data, error } = await state.client.auth.signInWithPassword({
      email,
      password: String(form.get('password') || ''),
    });
    if (error) throw error;
    state.session = data.session;
    state.sessionSource = 'manual';
    setFeedback('魂籍台帳へログインしました');
    await loadAccountData();
  });
}

async function resetPassword() {
  const form = document.getElementById('soulLoginForm');
  const email = String(new FormData(form).get('email') || '').trim();
  if (!email) {
    setFeedback('', 'メールアドレスを入力してください');
    render();
    return;
  }
  await withBusy(async () => {
    const { error } = await state.client.auth.resetPasswordForEmail(email, {
      redirectTo: `${location.origin}${location.pathname}`,
    });
    if (error) throw error;
    setFeedback('パスワード再設定メールを送りました');
  });
}

async function updateProfile(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  await withBusy(async () => {
    // 魂名は変更不可: display_nameはここでは触らない
    const newsletterOptIn = form.get('newsletter') === 'on';
    const gameProfile = window.EnmaGameBridge?.getProfile?.() || {};
    const [{ data, error }, { data: preferences, error: preferencesError }] =
      await Promise.all([
        state.client.from('profiles').update({
          soul_stage: gameProfile.soulStage || 'deceased',
          avatar_key: gameProfile.gender || 'm',
          last_seen_at: new Date().toISOString(),
        }).eq('id', state.session.user.id).select('*').single(),
        state.client.from('account_preferences').update({
          newsletter_opt_in: newsletterOptIn,
        }).eq('user_id', state.session.user.id).select('newsletter_opt_in').single(),
      ]);
    if (error) throw error;
    if (preferencesError) throw preferencesError;
    state.profile = data;
    state.preferences = preferences;
    syncOnlineControllers(state.session, state.profile);
    if (config.resendSyncFunction) {
      const { error: syncError } = await state.client.functions.invoke(
        config.resendSyncFunction,
        { body: { newsletterOptIn } },
      );
      if (syncError) throw new Error(`プロフィールは保存しましたが、メール設定の同期に失敗しました`);
    }
    setFeedback('プロフィールを保存しました');
  });
}

function scheduleCloudSave(delay = 600) {
  if (!state.client || !state.session?.user?.id
    || cloudSaveUserId !== state.session.user.id) return;
  if (cloudSaveInFlight) {
    cloudSaveQueued = true;
    return;
  }
  window.clearTimeout(cloudSaveTimer);
  cloudSaveTimer = window.setTimeout(() => void flushCloudSave(), delay);
}

async function fetchLatestCloudSave() {
  const { data, error } = await state.client.from('game_saves')
    .select('save_version,revision,client_updated_at,updated_at,payload')
    .eq('user_id', state.session.user.id).maybeSingle();
  if (error) throw error;
  state.cloudSave = data;
  cloudSaveUserId = state.session.user.id;
  return data;
}

async function reconcileCloudSave() {
  if (!state.client || !state.session?.user?.id) return true;
  bindLegacySaveIfSafe();
  const binding = saveBinding();
  const local = binding.local;
  const cloud = state.cloudSave;

  // 記録が無い端末、または別魂籍の端末ではログイン中の魂籍を自動で開く。
  // importSaveは別魂籍の端末記録を専用領域へ退避してから切り替える。
  if (cloud && (binding.kind === 'empty' || binding.kind === 'other')) {
    setAutoSyncState('loading', '最新のクラウド記録へ自動で切り替えています…');
    window.EnmaGameBridge?.importSave?.(cloud.payload, { ownerId: state.session.user.id });
    return false;
  }

  if (!cloud && binding.kind === 'empty') {
    // まっさらな魂籍は、最初のゲーム保存が起きる前にこの端末へ紐付けておく。
    window.EnmaGameBridge?.claimSave?.(state.session.user.id);
    setAutoSyncState('synced', 'プレイ開始後から自動保存します');
    return true;
  }

  if (binding.kind !== 'match') {
    setAutoSyncState('paused', '魂籍の確認が必要なため、自動同期を一時停止しています');
    return true;
  }
  if (!local.payload) return true;
  if (!cloud) {
    setAutoSyncState('saving', '最初のクラウド記録を自動保存しています…');
    scheduleCloudSave(0);
    return true;
  }

  const localSignature = payloadSignature(local.payload);
  const cloudSignature = payloadSignature(cloud.payload);
  if (localSignature === cloudSignature) {
    const syncedAt = new Date(cloud.updated_at).toLocaleTimeString('ja-JP', {
      hour: '2-digit', minute: '2-digit',
    });
    setAutoSyncState('synced', `自動保存済み（${syncedAt}）`);
    return true;
  }

  // 別端末の古い記録を後から開いても、徳位を巻き戻してクラウドへ保存しない。
  // 徳位が異なる場合は保存時刻より進行度を優先し、同じ徳位だけ時刻で比較する。
  const levelOrder = comparePayloadLevel(local.payload, cloud.payload);
  if (levelOrder < 0) {
    setAutoSyncState('loading', '進行したクラウド記録を自動で読み込んでいます…');
    window.EnmaGameBridge?.importSave?.(cloud.payload, { ownerId: state.session.user.id });
    return false;
  }
  if (levelOrder > 0) {
    setAutoSyncState('saving', '進行した端末記録をクラウドへ自動保存しています…');
    scheduleCloudSave(0);
    return true;
  }

  const localAt = payloadSavedAt(local.payload);
  const cloudAt = payloadSavedAt(cloud.payload, cloud.client_updated_at || cloud.updated_at);
  if (cloudAt > localAt) {
    setAutoSyncState('loading', '別端末の新しい記録を自動で読み込んでいます…');
    window.EnmaGameBridge?.importSave?.(cloud.payload, { ownerId: state.session.user.id });
    return false;
  }

  setAutoSyncState('saving', 'この端末の進行をクラウドへ自動保存しています…');
  scheduleCloudSave(0);
  return true;
}

async function flushCloudSave() {
  window.clearTimeout(cloudSaveTimer);
  cloudSaveTimer = 0;
  if (!state.client || !state.session?.user?.id) return;
  if (cloudSaveInFlight) {
    cloudSaveQueued = true;
    return;
  }
  const binding = saveBinding();
  const payload = binding.local.payload;
  if (binding.kind !== 'match' || !payload) return;
  if (state.cloudSave && comparePayloadLevel(payload, state.cloudSave.payload) < 0) {
    setAutoSyncState('loading', '進行したクラウド記録を自動で読み込んでいます…');
    window.EnmaGameBridge?.importSave?.(state.cloudSave.payload, {
      ownerId: state.session.user.id,
    });
    return;
  }
  if (state.cloudSave && payloadSignature(payload) === payloadSignature(state.cloudSave.payload)) {
    setAutoSyncState('synced', 'クラウドへ自動保存済み');
    return;
  }

  cloudSaveInFlight = true;
  cloudSaveQueued = false;
  let retryDelay = 0;
  setAutoSyncState('saving', 'クラウドへ自動保存中…');
  try {
    const savedAt = payloadSavedAt(payload) || Date.now();
    const values = {
      save_version: Number(payload.v) || 1,
      payload,
      revision: (state.cloudSave?.revision || 0) + 1,
      client_updated_at: new Date(savedAt).toISOString(),
    };
    let result;
    if (state.cloudSave) {
      result = await state.client.from('game_saves').update(values)
        .eq('user_id', state.session.user.id)
        .eq('revision', state.cloudSave.revision)
        .select('save_version,revision,client_updated_at,updated_at,payload').maybeSingle();
    } else {
      result = await state.client.from('game_saves').insert({
        user_id: state.session.user.id,
        ...values,
      }).select('save_version,revision,client_updated_at,updated_at,payload').single();
    }

    // ほかの端末が先に更新した場合は、上書きせず最新記録を取り直して比較する。
    if (result.error || !result.data) {
      if (result.error && result.error.code !== '23505') throw result.error;
      await fetchLatestCloudSave();
      await reconcileCloudSave();
      return;
    }
    state.cloudSave = result.data;
    setAutoSyncState('synced', 'クラウドへ自動保存済み');
  } catch (error) {
    setAutoSyncState('retrying', '通信が戻り次第、自動保存を再試行します');
    void reportSystemEvent({
      source: 'account', code: 'cloud_autosave_failed', severity: 'warning',
      message: error?.message || 'cloud autosave failed',
    });
    retryDelay = 10_000;
  } finally {
    cloudSaveInFlight = false;
    if (retryDelay) {
      cloudSaveQueued = false;
      scheduleCloudSave(retryDelay);
    } else if (cloudSaveQueued) {
      cloudSaveQueued = false;
      scheduleCloudSave(500);
    }
  }
}

async function downloadCloudSave() {
  await withBusy(async () => {
    const { data, error } = await state.client.from('game_saves').select('payload')
      .eq('user_id', state.session.user.id).single();
    if (error) throw error;
    const localLevel = window.EnmaGameBridge?.getProfile?.().level ?? '—';
    const cloudLevel = data.payload?.lv ?? '—';
    if (!confirm(`この端末の徳位${localLevel}の記録を、クラウドの徳位${cloudLevel}の記録で置き換えます。よろしいですか？`)) return;
    window.EnmaGameBridge?.importSave?.(data.payload, { ownerId: state.session.user.id });
  });
}

async function claimLocalSave() {
  const local = localSaveInfo();
  if (!local.payload || !state.session) return;
  if (!confirm(`端末の「${local.name}・徳位${local.level}」を、現在の魂籍の記録として使いますか？`)) return;
  window.EnmaGameBridge?.claimSave?.(state.session.user.id);
  setFeedback('端末記録を現在の魂籍へ紐付けました。自動同期を開始します');
  scheduleCloudSave(0);
  render();
}

async function restoreBoundSave() {
  if (!state.session) return;
  const payload = window.EnmaGameBridge?.getBoundSave?.(state.session.user.id);
  if (!payload) {
    setFeedback('', 'この魂籍の端末記録が見つかりません');
    render();
    return;
  }
  if (!confirm(`この端末を「${payload.name || 'ナナシ'}・徳位${payload.lv || 1}」の記録へ切り替えますか？`)) return;
  window.EnmaGameBridge?.activateBoundSave?.(state.session.user.id);
}

async function startFreshSave() {
  if (!state.session) return;
  if (!confirm('現在の端末記録は消さずに切り離し、この魂籍を徳位1から始めます。よろしいですか？')) return;
  window.EnmaGameBridge?.startFreshSave?.(state.session.user.id);
}

async function signOut() {
  if (!confirm('この端末だけ魂籍からログアウトします。ほかのスマホ・PCのログインと、端末のプレイ記録はそのまま残ります。')) return;
  await withBusy(async () => {
    const { error } = await state.client.auth.signOut({ scope: 'local' });
    if (error) throw error;
    state.session = null;
    state.profile = null;
    state.preferences = null;
    state.cloudSave = null;
    window.clearTimeout(cloudSaveTimer);
    window.clearTimeout(cloudReloadTimer);
    cloudSaveTimer = 0;
    cloudReloadTimer = 0;
    cloudSaveQueued = false;
    cloudSaveUserId = '';
    setAutoSyncState('offline', 'ログインすると自動同期します');
    syncOnlineControllers(null, null);
    state.authMode = 'login';
    state.sessionSource = 'manual';
    setFeedback('この端末だけログアウトしました。別の魂籍でログインできます');
  });
}

let initializeRevision = 0;
async function initialize(attempt = 0) {
  const revision = ++initializeRevision;
  render();
  if (!state.configured) return;
  try {
    const createClient = window.supabase?.createClient;
    if (!createClient) throw new Error('認証ライブラリを読み込めませんでした');
    state.client = createClient(config.supabaseUrl, config.supabasePublishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
    presenceController = createPresenceController(state.client);
    worldController = createWorldController(config);
    socialController = createSocialController(state.client);
    guildController = createGuildController(state.client);
    window.EnmaWorldClient = worldController;
    window.EnmaSocialClient = socialController;
    window.EnmaGuildClient = guildController;
    const { data, error } = await state.client.auth.getSession();
    if (error) throw error;
    state.session = data.session;
    state.client.auth.onAuthStateChange((event, session) => {
      state.session = session;
      if (event === 'TOKEN_REFRESHED') {
        void presenceController?.setAccount(session, state.profile);
        void worldController?.setAccount(session, state.profile);
        return;
      }
      setTimeout(() => {
        loadAccountData().catch(loadError => {
          setFeedback('', `魂籍情報を更新できません：${loadError?.message || '通信エラー'}`);
          render();
        });
      }, 0);
    });
    await loadAccountData();
  } catch (error) {
    if (revision !== initializeRevision) return;
    try { await presenceController?.stop?.(); } catch {}
    try { worldController?.stop?.(); } catch {}
    try { await socialController?.stop?.(); } catch {}
    try { await guildController?.stop?.(); } catch {}
    presenceController = null;
    worldController = null;
    socialController = null;
    guildController = null;
    window.EnmaWorldClient = null;
    window.EnmaSocialClient = null;
    window.EnmaGuildClient = null;
    state.client = null;
    setFeedback('', `魂籍台帳へ接続できません：${error?.message || '通信エラー'}`);
    content.innerHTML = `<p class="account-lead">魂籍台帳へ接続できませんでした。</p>${feedbackHtml()}
      <button class="buyb account-primary" id="accountRetry" type="button">もう一度接続する</button>
      <p class="account-note">接続できなくても、端末の記録でゲームを続けられます。</p>`;
    document.getElementById('accountRetry')?.addEventListener('click', () => initialize(0));
    if (attempt < 2) {
      window.setTimeout(() => {
        if (revision === initializeRevision && !state.client) void initialize(attempt + 1);
      }, 1_500 * (attempt + 1));
    }
  }
}

document.addEventListener('enma-account-open', render);
document.addEventListener('enma:local-save', () => scheduleCloudSave(600));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) scheduleCloudSave(0);
});
initialize();
