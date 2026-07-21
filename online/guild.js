// 講(ギルド)の台帳まわり。リアルタイム(講チャット・在席)はpresence.jsが担当し、
// このコントローラはSupabaseのRPC呼び出しと講情報の定期更新だけを受け持つ。
const GUILD_POLL_MS = 60_000;
const VALID_ID = /^[0-9a-f-]{16,64}$/i;

const cleanId = value => String(value || '').trim().slice(0, 64);
const cleanGuildName = value => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 12);

export function createGuildController(client, bridge = window.EnmaGameBridge) {
  let session = null;
  let pollTimer = 0;
  let refreshRevision = 0;

  const userId = () => session?.user?.id || '';

  function clearPoll() {
    if (pollTimer) window.clearInterval(pollTimer);
    pollTimer = 0;
  }

  function publish(guild, error = '') {
    bridge?.syncGuildState?.({
      online: Boolean(userId()),
      guild: guild || null,
      error,
    });
  }

  function normalizeGuild(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const ownId = userId();
    const members = (Array.isArray(raw.members) ? raw.members : []).map(member => ({
      userId: cleanId(member?.userId),
      name: String(member?.name || 'ナナシ').slice(0, 16),
      role: ['master', 'officer', 'member'].includes(member?.role) ? member.role : 'member',
      joinedAt: member?.joinedAt || '',
    })).filter(member => member.userId);
    return {
      id: cleanId(raw.id),
      name: cleanGuildName(raw.name),
      motto: String(raw.motto || '').slice(0, 60),
      masterId: cleanId(raw.masterId),
      memberLimit: Math.max(1, Number(raw.memberLimit) || 20),
      members,
      myRole: members.find(member => member.userId === ownId)?.role || 'member',
      selfId: ownId,
    };
  }

  async function refresh() {
    const ownId = userId();
    const revision = ++refreshRevision;
    if (!ownId) {
      publish(null);
      return null;
    }
    try {
      const { data, error } = await client.rpc('get_guild_info');
      if (error) throw error;
      if (revision !== refreshRevision || ownId !== userId()) return null;
      const guild = normalizeGuild(data);
      publish(guild);
      return guild;
    } catch (error) {
      if (revision === refreshRevision) {
        publish(null, error?.message || '講の台帳を読み込めませんでした');
      }
      throw error;
    }
  }

  async function createGuild(rawName) {
    if (!userId()) throw new Error('講の設立には魂籍ログインが必要です');
    const name = cleanGuildName(rawName);
    if (name.length < 2) throw new Error('講名は2〜12文字で入力してください');
    const { error } = await client.rpc('create_guild', { p_name: name });
    if (error) throw error;
    return refresh();
  }

  async function join(rawGuildId) {
    const guildId = cleanId(rawGuildId);
    if (!userId() || !VALID_ID.test(guildId)) throw new Error('講を確認できません');
    const { error } = await client.rpc('join_guild', { p_guild_id: guildId });
    if (error) throw error;
    return refresh();
  }

  async function leave() {
    if (!userId()) throw new Error('魂籍ログインが必要です');
    const { error } = await client.rpc('leave_guild');
    if (error) throw error;
    return refresh();
  }

  async function disband() {
    if (!userId()) throw new Error('魂籍ログインが必要です');
    const { error } = await client.rpc('disband_guild');
    if (error) throw error;
    return refresh();
  }

  async function kick(rawUserId) {
    const targetId = cleanId(rawUserId);
    if (!userId() || !VALID_ID.test(targetId)) throw new Error('対象を確認できません');
    const { error } = await client.rpc('kick_guild_member', { p_user_id: targetId });
    if (error) throw error;
    return refresh();
  }

  async function setRole(rawUserId, role) {
    const targetId = cleanId(rawUserId);
    if (!userId() || !VALID_ID.test(targetId)) throw new Error('対象を確認できません');
    if (!['officer', 'member'].includes(role)) throw new Error('役職の指定が正しくありません');
    const { error } = await client.rpc('set_guild_role', { p_user_id: targetId, p_role: role });
    if (error) throw error;
    return refresh();
  }

  async function setAccount(nextSession) {
    clearPoll();
    session = nextSession || null;
    if (!session) {
      publish(null);
      return;
    }
    await refresh().catch(() => {});
    pollTimer = window.setInterval(() => {
      if (!document.hidden) refresh().catch(() => {});
    }, GUILD_POLL_MS);
  }

  async function stop() {
    clearPoll();
    refreshRevision++;
    session = null;
    publish(null);
  }

  return {
    setAccount,
    refresh,
    createGuild,
    join,
    leave,
    disband,
    kick,
    setRole,
    stop,
  };
}
