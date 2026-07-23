import { createClient } from 'jsr:@supabase/supabase-js@2'

const allowedOrigins = new Set([
  'https://enmacho.com',
  'https://enmacho-online.pages.dev',
  'https://aji42074567-stack.github.io',
  'http://127.0.0.1:8765',
])

const GA_PROPERTY_ID = '546813112'
const SEARCH_CONSOLE_SITE = 'sc-domain:enmacho.com'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/webmasters.readonly',
].join(' ')

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
    headers: {
      ...corsHeaders(request),
      'Cache-Control': 'private, no-store',
      'Content-Type': 'application/json; charset=utf-8',
    },
  })

const base64Url = (value: Uint8Array | string) => {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  let binary = ''
  for (let index = 0; index < bytes.length; index += 8192) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192))
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

const pemBytes = (pem: string) => {
  const encoded = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s/g, '')
  const binary = atob(encoded)
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

type ServiceAccount = {
  client_email: string
  private_key: string
}

type TokenCache = {
  accessToken: string
  expiresAt: number
}

let tokenCache: TokenCache | null = null

const readServiceAccount = (): ServiceAccount => {
  const raw = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_JSON')
  if (!raw) throw new Error('Google service account secret is missing')
  let parsed: Partial<ServiceAccount>
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('Google service account secret is invalid')
  }
  const clientEmail = String(parsed.client_email || '').trim()
  const privateKey = String(parsed.private_key || '').replace(/\\n/g, '\n').trim()
  if (!clientEmail || !privateKey.includes('BEGIN PRIVATE KEY'))
    throw new Error('Google service account credentials are incomplete')
  return { client_email: clientEmail, private_key: privateKey }
}

async function googleAccessToken() {
  if (tokenCache && Date.now() < tokenCache.expiresAt - 60_000) return tokenCache.accessToken
  const account = readServiceAccount()
  const issuedAt = Math.floor(Date.now() / 1000)
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = base64Url(JSON.stringify({
    iss: account.client_email,
    scope: GOOGLE_SCOPES,
    aud: GOOGLE_TOKEN_URL,
    iat: issuedAt,
    exp: issuedAt + 3600,
  }))
  const unsignedToken = `${header}.${claims}`
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemBytes(account.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(unsignedToken),
  )
  const assertion = `${unsignedToken}.${base64Url(new Uint8Array(signature))}`
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok || !result.access_token) {
    console.error('Google token request failed', response.status, result?.error || 'unknown')
    throw new Error('Google authentication failed')
  }
  tokenCache = {
    accessToken: String(result.access_token),
    expiresAt: Date.now() + Math.max(300, Number(result.expires_in) || 3600) * 1000,
  }
  return tokenCache.accessToken
}

async function googleJson(token: string, url: string, body: unknown) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) {
    console.error('Google API request failed', response.status, url, result?.error?.message || '')
    throw new Error(`Google API ${response.status}`)
  }
  return result
}

const isoDate = (date: Date) => date.toISOString().slice(0, 10)

const reportDate = (value: string) => /^\d{8}$/.test(value)
  ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
  : value

const asNumber = (value: unknown) => {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

type GaReport = {
  dimensionHeaders?: Array<{ name?: string }>
  metricHeaders?: Array<{ name?: string }>
  rows?: Array<{
    dimensionValues?: Array<{ value?: string }>
    metricValues?: Array<{ value?: string }>
  }>
}

const gaRows = (report?: GaReport) => {
  const dimensions = (report?.dimensionHeaders || []).map(header => String(header.name || ''))
  const metrics = (report?.metricHeaders || []).map(header => String(header.name || ''))
  return (report?.rows || []).map(row => {
    const normalized: Record<string, string | number> = {}
    dimensions.forEach((name, index) => {
      const value = String(row.dimensionValues?.[index]?.value || '')
      normalized[name] = name === 'date' ? reportDate(value) : value
    })
    metrics.forEach((name, index) => {
      normalized[name] = asNumber(row.metricValues?.[index]?.value)
    })
    return normalized
  })
}

type SearchRow = {
  keys?: string[]
  clicks?: number
  impressions?: number
  ctr?: number
  position?: number
}

const searchRows = (result: { rows?: SearchRow[] }, dimension?: string) =>
  (result.rows || []).map(row => ({
    ...(dimension ? { [dimension]: String(row.keys?.[0] || '') } : {}),
    clicks: asNumber(row.clicks),
    impressions: asNumber(row.impressions),
    ctr: asNumber(row.ctr),
    position: asNumber(row.position),
  }))

async function loadGa(token: string, startDate: string, endDate: string) {
  const dateRanges = [{ startDate, endDate }]
  const batch = await googleJson(
    token,
    `https://analyticsdata.googleapis.com/v1beta/properties/${GA_PROPERTY_ID}:batchRunReports`,
    {
      requests: [
        {
          dateRanges,
          metrics: [
            { name: 'activeUsers' }, { name: 'sessions' }, { name: 'screenPageViews' },
            { name: 'newUsers' }, { name: 'averageSessionDuration' }, { name: 'engagementRate' },
          ],
        },
        {
          dateRanges,
          dimensions: [{ name: 'date' }],
          metrics: [{ name: 'activeUsers' }, { name: 'sessions' }, { name: 'screenPageViews' }],
          orderBys: [{ dimension: { dimensionName: 'date' } }],
          limit: '100',
        },
        {
          dateRanges,
          dimensions: [{ name: 'sessionDefaultChannelGroup' }],
          metrics: [{ name: 'sessions' }, { name: 'activeUsers' }],
          orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
          limit: '8',
        },
        {
          dateRanges,
          dimensions: [{ name: 'pageTitle' }, { name: 'pagePath' }],
          metrics: [{ name: 'screenPageViews' }, { name: 'activeUsers' }, { name: 'averageSessionDuration' }],
          orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
          limit: '10',
        },
      ],
    },
  )
  const realtime = await googleJson(
    token,
    `https://analyticsdata.googleapis.com/v1beta/properties/${GA_PROPERTY_ID}:runRealtimeReport`,
    { metrics: [{ name: 'activeUsers' }] },
  ).catch(error => {
    console.error('GA realtime request failed', error)
    return { rows: [] }
  })
  const reports = batch.reports || []
  const totals = gaRows(reports[0])[0] || {}
  return {
    totals,
    realtimeUsers: asNumber(realtime?.rows?.[0]?.metricValues?.[0]?.value),
    daily: gaRows(reports[1]),
    channels: gaRows(reports[2]),
    pages: gaRows(reports[3]),
  }
}

async function loadSearch(token: string, startDate: string, endDate: string) {
  const endpoint = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(SEARCH_CONSOLE_SITE)}/searchAnalytics/query`
  const common = { startDate, endDate, dataState: 'all' }
  const [summary, daily, queries, pages] = await Promise.all([
    googleJson(token, endpoint, { ...common, rowLimit: 1 }),
    googleJson(token, endpoint, { ...common, dimensions: ['date'], rowLimit: 100 }),
    googleJson(token, endpoint, { ...common, dimensions: ['query'], rowLimit: 10 }),
    googleJson(token, endpoint, { ...common, dimensions: ['page'], rowLimit: 10 }),
  ])
  return {
    totals: searchRows(summary)[0] || { clicks: 0, impressions: 0, ctr: 0, position: 0 },
    daily: searchRows(daily, 'date'),
    queries: searchRows(queries, 'query'),
    pages: searchRows(pages, 'page'),
  }
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
  if (!supabaseUrl || !anonKey)
    return json(request, { error: 'server configuration is incomplete' }, 500)

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
  })
  const { data: { user }, error: userError } = await userClient.auth.getUser()
  if (userError || !user) return json(request, { error: 'invalid session' }, 401)
  const { data: isAdmin, error: adminCheckError } = await userClient.rpc('is_enma_admin')
  if (adminCheckError || isAdmin !== true)
    return json(request, { error: 'admin access required' }, 403)

  const requested = await request.json().catch(() => ({}))
  const days = [7, 28, 90].includes(Number(requested.days)) ? Number(requested.days) : 28
  const end = new Date()
  end.setUTCDate(end.getUTCDate() - 1)
  const start = new Date(end)
  start.setUTCDate(start.getUTCDate() - days + 1)
  const startDate = isoDate(start)
  const endDate = isoDate(end)

  try {
    const token = await googleAccessToken()
    const [gaResult, searchResult] = await Promise.allSettled([
      loadGa(token, startDate, endDate),
      loadSearch(token, startDate, endDate),
    ])
    const errors: Record<string, string> = {}
    if (gaResult.status === 'rejected') {
      console.error('GA dashboard request failed', gaResult.reason)
      errors.ga = 'GA4のデータを取得できませんでした'
    }
    if (searchResult.status === 'rejected') {
      console.error('Search Console dashboard request failed', searchResult.reason)
      errors.search = 'Search Consoleのデータを取得できませんでした'
    }
    if (gaResult.status === 'rejected' && searchResult.status === 'rejected')
      return json(request, { error: 'Googleの解析データを取得できませんでした', errors }, 502)
    return json(request, {
      ok: true,
      generatedAt: new Date().toISOString(),
      range: { days, startDate, endDate },
      ga: gaResult.status === 'fulfilled' ? gaResult.value : null,
      search: searchResult.status === 'fulfilled' ? searchResult.value : null,
      errors,
    })
  } catch (error) {
    console.error('Admin analytics failed', error)
    const configurationError = String(error).includes('service account')
    return json(request, {
      error: configurationError
        ? 'Google解析APIの接続設定が完了していません'
        : 'Google解析APIへ接続できませんでした',
    }, configurationError ? 503 : 502)
  }
})
