import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405)

  const authorization = request.headers.get('Authorization')
  if (!authorization) return json({ error: 'authentication required' }, 401)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const resendApiKey = Deno.env.get('RESEND_API_KEY')
  const resendSegmentId = Deno.env.get('RESEND_SEGMENT_ID')
  if (!supabaseUrl || !supabaseAnonKey || !resendApiKey) {
    return json({ error: 'server configuration is incomplete' }, 500)
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authorization } },
  })
  const { data: { user }, error: userError } = await supabase.auth.getUser()
  if (userError || !user?.email) return json({ error: 'invalid session' }, 401)

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('display_name')
    .eq('id', user.id)
    .single()
  if (profileError) return json({ error: 'profile not found' }, 404)
  const { data: preferences, error: preferencesError } = await supabase
    .from('account_preferences')
    .select('newsletter_opt_in')
    .eq('user_id', user.id)
    .single()
  if (preferencesError) return json({ error: 'account preferences not found' }, 404)

  const requested = await request.json().catch(() => ({}))
  const optedIn = requested.newsletterOptIn === true && preferences.newsletter_opt_in === true
  const headers = {
    Authorization: `Bearer ${resendApiKey}`,
    'Content-Type': 'application/json',
  }
  const encodedEmail = encodeURIComponent(user.email)
  const existing = await fetch(`https://api.resend.com/contacts/${encodedEmail}`, { headers })

  let resendResponse: Response
  if (existing.ok) {
    resendResponse = await fetch(`https://api.resend.com/contacts/${encodedEmail}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ unsubscribed: !optedIn }),
    })
  } else if (existing.status === 404) {
    resendResponse = await fetch('https://api.resend.com/contacts', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        email: user.email,
        unsubscribed: !optedIn,
        ...(optedIn && resendSegmentId ? { segments: [{ id: resendSegmentId }] } : {}),
      }),
    })
  } else {
    return json({ error: 'could not inspect Resend contact' }, 502)
  }

  if (!resendResponse.ok) {
    const detail = await resendResponse.text()
    console.error('Resend contact sync failed', resendResponse.status, detail)
    return json({ error: 'Resend contact sync failed' }, 502)
  }

  return json({ ok: true, subscribed: optedIn })
})
