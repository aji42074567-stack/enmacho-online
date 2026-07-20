/*
 * 公開してよい値だけを置く。
 * Supabase の Secret key / service_role key、Resend API key は絶対に置かないこと。
 */
window.ENMA_ONLINE_CONFIG = {
  supabaseUrl: '',
  supabasePublishableKey: '',
  resendSyncFunction: 'sync-resend-contact',
};
