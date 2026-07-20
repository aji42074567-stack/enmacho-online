/*
 * 公開してよい値だけを置く。
 * Supabase の Secret key / service_role key、Resend API key は絶対に置かないこと。
 */
window.ENMA_ONLINE_CONFIG = {
  supabaseUrl: 'https://xdsbhayygewhychrapcj.supabase.co',
  supabasePublishableKey: 'sb_publishable_eR2B-UdqrTYt1yp7V-G5tQ_vYoFKaIj',
  resendSyncFunction: 'sync-resend-contact',
  worldServerUrl: 'https://enmacho-world.aji42074567.workers.dev',
};
