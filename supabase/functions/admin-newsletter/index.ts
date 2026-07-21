import { createClient } from 'jsr:@supabase/supabase-js@2'

const allowedOrigins = new Set([
  'https://enmacho.com',
  'https://enmacho-online.pages.dev',
  'https://aji42074567-stack.github.io',
  'http://127.0.0.1:8765',
])

const corsHeaders = (request: Request) => {
  const origin = request.headers.get('Origin') || ''
  return {
    'Access-Control-Allow-Origin': allowedOrigins.has(origin) ? origin : 'https://enmacho.com',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Vary': 'Origin',
  }
}

const json = (request: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(request), 'Content-Type': 'application/json' },
  })

const cleanText = (value: unknown, max: number) =>
  String(value || '').replace(/[\r\n]+/g, ' ').trim().slice(0, max)

const escapeHtml = (value: unknown) => String(value || '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char] || char))

const emailHtml = (body: string, test = false) => {
  const paragraphs = body.split(/\n{2,}/).map(part =>
    `<p style="margin:0 0 20px;line-height:1.9">${escapeHtml(part).replace(/\n/g, '<br>')}</p>`
  ).join('')
  return `<!doctype html><html lang="ja"><body style="margin:0;background:#090909;color:#eadfc8">
    <div style="max-width:640px;margin:auto;padding:36px 24px;font-family:serif">
      <div style="color:#d4ae55;font-size:24px;letter-spacing:.12em;margin-bottom:26px">閻魔庁ONLINE</div>
      ${test ? '<p style="color:#78d7d0">【管理者テスト送信】</p>' : ''}
      <div style="font-size:15px">${paragraphs}</div>
      <hr style="border:0;border-top:1px solid #4a3b22;margin:32px 0">
      <p style="font-size:12px;color:#9a8c6f">閻魔庁ONLINE 運営</p>
      ${test ? '' : '<p style="font-size:11px"><a style="color:#c9a24a" href="{{{RESEND_UNSUBSCRIBE_URL}}}">更新情報メールの配信を停止する</a></p>'}
    </div></body></html>`
}

type ResendConfig = {
  apiKey: string
  segmentId: string
}

async function resendRequest(config: ResendConfig, path: string, init: RequestInit = {}) {
  return fetch(`https://api.resend.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  })
}

async function syncContact(config: ResendConfig, email: string, optedIn: boolean) {
  const encodedEmail = encodeURIComponent(email)
  const existing = await resendRequest(config, `/contacts/${encodedEmail}`)
  if (existing.ok) {
    const updated = await resendRequest(config, `/contacts/${encodedEmail}`, {
      method: 'PATCH',
      body: JSON.stringify({ unsubscribed: !optedIn }),
    })
    if (!updated.ok) throw new Error(`contact update failed (${updated.status})`)
  } else if (existing.status === 404) {
    const created = await resendRequest(config, '/contacts', {
      method: 'POST',
      body: JSON.stringify({
        email,
        unsubscribed: !optedIn,
        ...(optedIn && config.segmentId ? { segments: [{ id: config.segmentId }] } : {}),
      }),
    })
    if (!created.ok) throw new Error(`contact create failed (${created.status})`)
  } else {
    throw new Error(`contact lookup failed (${existing.status})`)
  }

  if (optedIn && config.segmentId) {
    const added = await resendRequest(
      config,
      `/contacts/${encodedEmail}/segments/${encodeURIComponent(config.segmentId)}`,
      { method: 'POST' },
    )
    if (!added.ok && added.status !== 409)
      throw new Error(`segment update failed (${added.status})`)
  }
}

async function listAudience(database: any) {
  const users: Array<{ email: string; newsletter_opt_in: boolean }> = []
  for (let offset = 0; ; offset += 100) {
    const { data, error } = await database.rpc('admin_list_users', {
      p_search: '',
      p_limit: 100,
      p_offset: offset,
    })
    if (error) throw error
    users.push(...(data || []))
    if (!data || data.length < 100) break
  }
  return users
}

async function syncAudience(database: any, resend: ResendConfig) {
  const users = await listAudience(database)
  let synced = 0
  let subscribed = 0
  for (const user of users) {
    if (!user.email) continue
    const optedIn = user.newsletter_opt_in === true
    await syncContact(resend, user.email, optedIn)
    synced++
    if (optedIn) subscribed++
  }
  return { synced, subscribed }
}

Deno.serve(async request => {
  const origin = request.headers.get('Origin') || ''
  if (origin && !allowedOrigins.has(origin)) return json(request, { error: 'origin not allowed' }, 403)
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(request) })
  if (request.method !== 'POST') return json(request, { error: 'method not allowed' }, 405)

  const authorization = request.headers.get('Authorization')
  if (!authorization) return json(request, { error: 'authentication required' }, 401)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const resendApiKey = Deno.env.get('RESEND_API_KEY')
  const resendSegmentId = Deno.env.get('RESEND_SEGMENT_ID')
  if (!supabaseUrl || !anonKey || !resendApiKey || !resendSegmentId)
    return json(request, { error: 'server configuration is incomplete' }, 500)

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
  })
  const { data: { user }, error: userError } = await userClient.auth.getUser()
  if (userError || !user) return json(request, { error: 'invalid session' }, 401)

  // 呼び出し元のJWTのままSECURITY DEFINER関数へ照会し、以後もRLSを保つ。
  const { data: isAdmin, error: adminCheckError } = await userClient.rpc('is_enma_admin')
  if (adminCheckError || isAdmin !== true)
    return json(request, { error: 'admin access required' }, 403)

  const database = userClient

  const requested = await request.json().catch(() => ({}))
  const action = cleanText(requested.action, 20)
  const resend = { apiKey: resendApiKey, segmentId: resendSegmentId }

  try {
    if (action === 'sync') {
      return json(request, { ok: true, ...(await syncAudience(database, resend)) })
    }

    const campaignId = cleanText(requested.campaignId, 64)
    if (!campaignId) return json(request, { error: 'campaign is required' }, 400)
    const [{ data: campaign, error: campaignError }, { data: settings, error: settingsError }] =
      await Promise.all([
        database.from('email_campaigns').select('*').eq('id', campaignId).single(),
        database.from('admin_email_settings').select('*').eq('id', 1).single(),
      ])
    if (campaignError || !campaign) return json(request, { error: 'campaign not found' }, 404)
    if (settingsError || !settings) return json(request, { error: 'email settings not found' }, 500)

    const fromName = cleanText(settings.from_name, 60).replace(/[<>]/g, '')
    const fromEmail = cleanText(settings.from_email, 254)
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromEmail))
      return json(request, { error: 'sender email is invalid' }, 400)
    const from = `${fromName} <${fromEmail}>`

    if (action === 'test') {
      const to = cleanText(settings.test_recipient, 254)
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to))
        return json(request, { error: 'test recipient is invalid' }, 400)
      const response = await resendRequest(resend, '/emails', {
        method: 'POST',
        body: JSON.stringify({
          from,
          to: [to],
          subject: `【テスト】${campaign.subject}`,
          html: emailHtml(campaign.body_text, true),
          text: `【管理者テスト送信】\n\n${campaign.body_text}`,
        }),
      })
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 500)
        console.error('Resend test failed', response.status, detail)
        return json(request, { error: 'test delivery failed' }, 502)
      }
      return json(request, { ok: true, testRecipient: to })
    }

    if (action !== 'send') return json(request, { error: 'unknown action' }, 400)
    if (!settings.delivery_enabled)
      return json(request, { error: 'live delivery is disabled' }, 409)
    if (!['draft', 'failed'].includes(campaign.status))
      return json(request, { error: 'campaign was already submitted' }, 409)

    const audience = await syncAudience(database, resend)
    if (audience.subscribed < 1)
      return json(request, { error: 'there are no subscribed recipients' }, 409)
    await database.from('email_campaigns').update({
      status: 'sending',
      target_count: audience.subscribed,
      error_message: null,
    }).eq('id', campaign.id)

    const response = await resendRequest(resend, '/broadcasts', {
      method: 'POST',
      body: JSON.stringify({
        segment_id: resend.segmentId,
        from,
        name: campaign.name,
        subject: campaign.subject,
        html: emailHtml(campaign.body_text),
        text: `${campaign.body_text}\n\n配信停止: {{{RESEND_UNSUBSCRIBE_URL}}}`,
        send: true,
      }),
    })
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500)
      console.error('Resend broadcast failed', response.status, detail)
      await database.from('email_campaigns').update({
        status: 'failed',
        error_message: `Resend ${response.status}: ${detail}`.slice(0, 1000),
      }).eq('id', campaign.id)
      return json(request, { error: 'broadcast delivery failed' }, 502)
    }
    const result = await response.json().catch(() => ({}))
    await database.from('email_campaigns').update({
      status: 'submitted',
      target_count: audience.subscribed,
      resend_broadcast_id: cleanText(result.id, 128),
      submitted_at: new Date().toISOString(),
      error_message: null,
    }).eq('id', campaign.id)
    return json(request, {
      ok: true,
      submitted: audience.subscribed,
      broadcastId: result.id || '',
    })
  } catch (error) {
    console.error('admin-newsletter failed', error)
    const message = error instanceof Error ? error.message : 'operation failed'
    return json(request, { error: message }, 500)
  }
})
