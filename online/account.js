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
  configured: Boolean(config.supabaseUrl && config.supabasePublishableKey),
  message: importedCloudLevel
    ? `クラウド記録を読み込みました（徳位${importedCloudLevel}）。ゲーム画面へ進めます`
    : '',
  error: '',
  busy: false,
};

let accountLoadRevision = 0;

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const isJwtClockSkew = error => /JWT issued at future/i.test(error?.message || '');

const setFeedback = (message = '', error = '') => {
  state.message = message;
  state.error = error;
};

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
  setButtonState(state.message.includes('確認メール') ? 'pending' : 'offline');
  setGatewayCopy('魂籍を登録・照合', '登録せず端末の記録で続ける');
  content.innerHTML = `
    ${feedbackHtml()}
    <p class="account-lead">無料の魂籍を作ると、端末を越えて記録を残せます。</p>
    <form id="soulSignupForm" class="account-form">
      <label>魂名
        <input name="displayName" maxlength="16" required
          value="${esc(window.EnmaGameBridge?.getProfile()?.displayName || '')}"
          placeholder="ゲーム内で表示する名前" autocomplete="nickname">
      </label>
      <label>メールアドレス
        <input name="email" type="email" required placeholder="name@example.com"
          autocomplete="email">
      </label>
      <label>パスワード
        <input name="password" type="password" minlength="8" required
          placeholder="8文字以上" autocomplete="new-password">
      </label>
      <label class="account-check">
        <input name="newsletter" type="checkbox">
        <span>更新情報をメールで受け取る（いつでも解除できます）</span>
      </label>
      <button class="buyb account-primary" type="submit" ${state.busy ? 'disabled' : ''}>魂籍を登録</button>
    </form>
    <div class="account-divider"><span>登録済みの方</span></div>
    <form id="soulLoginForm" class="account-form compact">
      <label>メールアドレス
        <input name="email" type="email" required autocomplete="email">
      </label>
      <label>パスワード
        <input name="password" type="password" required autocomplete="current-password">
      </label>
      <button class="buyb account-primary" type="submit" ${state.busy ? 'disabled' : ''}>ログイン</button>
      <button class="linkbtn account-reset" id="soulResetPassword" type="button">パスワードを再設定</button>
    </form>`;

  document.getElementById('soulSignupForm')?.addEventListener('submit', signUp);
  document.getElementById('soulLoginForm')?.addEventListener('submit', signIn);
  document.getElementById('soulResetPassword')?.addEventListener('click', resetPassword);
}

function stageLabel(stage) {
  if (stage === 'reincarnated') return '転生者';
  if (stage === 'rebirth_candidate') return '転生候補者';
  return '亡者';
}

function renderSignedIn() {
  const profile = state.profile || {};
  const local = window.EnmaGameBridge?.getProfile?.() || {};
  const cloud = state.cloudSave;
  setButtonState('online');
  setGatewayCopy('魂籍照合済み', 'ゲーム画面へ進む');
  content.innerHTML = `
    ${feedbackHtml()}
    <div class="account-code">
      <span>魂籍番号</span>
      <strong>${esc(profile.soul_code || '発行待ち')}</strong>
      <small>転生後も変わらないフレンド検索用の番号</small>
    </div>
    <div class="account-grid">
      <div><span>魂名</span><b>${esc(profile.display_name || local.displayName || 'ナナシ')}</b></div>
      <div><span>身分</span><b>${esc(stageLabel(profile.soul_stage || local.soulStage))}</b></div>
      <div><span>徳位</span><b>${esc(local.level ?? '—')}</b></div>
      <div><span>メール</span><b class="account-email">${esc(state.session?.user?.email || '')}</b></div>
    </div>
    <form id="soulProfileForm" class="account-form compact account-profile-form">
      <label>魂名を変更
        <input name="displayName" maxlength="16" required
          value="${esc(profile.display_name || local.displayName || '')}">
      </label>
      <label class="account-check">
        <input name="newsletter" type="checkbox" ${state.preferences?.newsletter_opt_in ? 'checked' : ''}>
        <span>更新情報をメールで受け取る</span>
      </label>
      <button class="buyb" type="submit" ${state.busy ? 'disabled' : ''}>プロフィールを保存</button>
    </form>
    <div class="account-divider"><span>魂の記録</span></div>
    <div class="account-cloud">
      <p>${cloud
        ? `クラウド記録：徳位${esc(cloud.payload?.lv ?? '—')}・v${esc(cloud.save_version)}・${esc(new Date(cloud.updated_at).toLocaleString('ja-JP'))}`
        : 'クラウド記録はまだありません'}</p>
      <div class="account-actions">
        <button class="buyb" id="cloudUpload" type="button" ${state.busy ? 'disabled' : ''}>端末 → クラウドへ保存</button>
        <button class="buyb" id="cloudDownload" type="button"
          ${state.busy || !cloud ? 'disabled' : ''}>クラウド → この端末へ読込</button>
      </div>
    </div>
    <button class="linkbtn account-logout" id="soulLogout" type="button">ログアウト</button>`;

  document.getElementById('soulProfileForm')?.addEventListener('submit', updateProfile);
  document.getElementById('cloudUpload')?.addEventListener('click', uploadCloudSave);
  document.getElementById('cloudDownload')?.addEventListener('click', downloadCloudSave);
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
    state.client.from('game_saves').select('save_version,revision,updated_at,payload')
      .eq('user_id', userId).maybeSingle(),
  ]);
  return { profileResult, preferencesResult, cloudSaveResult };
}

async function loadAccountData() {
  const revision = ++accountLoadRevision;
  if (!state.session || !state.client) {
    state.profile = null;
    state.preferences = null;
    state.cloudSave = null;
    render();
    return;
  }
  const userId = state.session.user.id;
  let results = await fetchAccountData(userId);
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
    results = await fetchAccountData(userId);
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
    setFeedback('', isJwtClockSkew(saveError)
      ? '認証情報の時刻を同期できませんでした。数秒待ってアカウント画面を開き直してください'
      : `クラウド記録を確認できませんでした：${saveError.message}`);
  } else {
    state.error = '';
  }
  state.profile = profile;
  state.preferences = preferences;
  state.cloudSave = cloudSave;
  render();
}

async function withBusy(action) {
  if (state.busy) return;
  state.busy = true;
  render();
  try {
    await action();
  } catch (error) {
    setFeedback('', error?.message || '処理に失敗しました');
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
    const displayName = String(form.get('displayName') || '').trim().slice(0, 16);
    const newsletterOptIn = form.get('newsletter') === 'on';
    const { data, error } = await state.client.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${location.origin}${location.pathname}`,
        data: { display_name: displayName, newsletter_opt_in: newsletterOptIn },
      },
    });
    if (error) throw error;
    state.session = data.session;
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
    const { data, error } = await state.client.auth.signInWithPassword({
      email: String(form.get('email') || '').trim(),
      password: String(form.get('password') || ''),
    });
    if (error) throw error;
    state.session = data.session;
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
    const displayName = String(form.get('displayName') || '').trim().slice(0, 16);
    const newsletterOptIn = form.get('newsletter') === 'on';
    const gameProfile = window.EnmaGameBridge?.getProfile?.() || {};
    const [{ data, error }, { data: preferences, error: preferencesError }] =
      await Promise.all([
        state.client.from('profiles').update({
          display_name: displayName,
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

async function uploadCloudSave() {
  await withBusy(async () => {
    const payload = window.EnmaGameBridge?.exportSave?.();
    if (!payload) throw new Error('この端末に保存記録がありません');
    const { data, error } = await state.client.from('game_saves').upsert({
      user_id: state.session.user.id,
      save_version: Number(payload.v) || 1,
      payload,
      revision: (state.cloudSave?.revision || 0) + 1,
      client_updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' })
      .select('save_version,revision,updated_at,payload').single();
    if (error) throw error;
    state.cloudSave = data;
    setFeedback('この端末の記録をクラウドへ保存しました');
  });
}

async function downloadCloudSave() {
  await withBusy(async () => {
    const { data, error } = await state.client.from('game_saves').select('payload')
      .eq('user_id', state.session.user.id).single();
    if (error) throw error;
    const localLevel = window.EnmaGameBridge?.getProfile?.().level ?? '—';
    const cloudLevel = data.payload?.lv ?? '—';
    if (!confirm(`この端末の徳位${localLevel}の記録を、クラウドの徳位${cloudLevel}の記録で置き換えます。よろしいですか？`)) return;
    window.EnmaGameBridge?.importSave?.(data.payload);
  });
}

async function signOut() {
  await withBusy(async () => {
    const { error } = await state.client.auth.signOut();
    if (error) throw error;
    state.session = null;
    state.profile = null;
    state.preferences = null;
    state.cloudSave = null;
    setFeedback('ログアウトしました');
  });
}

async function initialize() {
  render();
  if (!state.configured) return;
  try {
    const { createClient } = await import(
      'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'
    );
    state.client = createClient(config.supabaseUrl, config.supabasePublishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
    const { data, error } = await state.client.auth.getSession();
    if (error) throw error;
    state.session = data.session;
    state.client.auth.onAuthStateChange((event, session) => {
      state.session = session;
      if (event === 'TOKEN_REFRESHED') return;
      setTimeout(() => loadAccountData(), 0);
    });
    await loadAccountData();
  } catch (error) {
    state.client = null;
    setFeedback('', `魂籍台帳へ接続できません：${error?.message || '通信エラー'}`);
    content.innerHTML = `<p class="account-lead">魂籍台帳へ接続できませんでした。</p>${feedbackHtml()}
      <p class="account-note">未ログインのままゲームを続けられます。</p>`;
  }
}

document.addEventListener('enma-account-open', render);
initialize();
