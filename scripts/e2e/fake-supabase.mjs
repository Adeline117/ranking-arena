#!/usr/bin/env node
// Hermetic stand-in for Supabase's HTTP surface. E2E runs point the app here so
// a pull request can exercise real pages without any production credential.
//
// Only the PostgREST features the core path uses are implemented. A relation
// without a fixture returns an empty list, which is what an empty table returns
// and what the app must already survive. Each period has its own trader names
// so a test can prove that switching period really changed the data.
import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

export const PERIODS = ['7D', '30D', '90D']

const TRADERS_PER_PERIOD = 30

function buildRow(period, index, nowIso) {
  const rank = index + 1
  const source = index % 2 === 0 ? 'binance_futures' : 'hyperliquid'
  return {
    season_id: period,
    source,
    source_type: source === 'hyperliquid' ? 'web3' : 'futures',
    source_trader_id: `e2e-${period.toLowerCase()}-${rank}`,
    handle: `E2E ${period} Trader ${rank}`,
    avatar_url: null,
    rank,
    rank_change: 0,
    is_new: false,
    arena_score: 95 - index,
    roi: 300 - index * 5,
    pnl: 500_000 - index * 10_000,
    win_rate: 60,
    max_drawdown: 12,
    trades_count: 200,
    followers: 100,
    copiers: 10,
    profitability_score: 50,
    risk_control_score: 30,
    execution_score: 10,
    score_completeness: 'full',
    metrics_estimated: false,
    is_outlier: false,
    trading_style: null,
    avg_holding_hours: null,
    sharpe_ratio: 1.5,
    sortino_ratio: null,
    profit_factor: null,
    calmar_ratio: null,
    trader_type: null,
    computed_at: nowIso,
  }
}

export const TEST_USER = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'e2e@example.com',
  password: 'e2e-password',
}

function buildAccessToken() {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const exp = Math.floor(Date.now() / 1000) + 3600
  return [
    encode({ alg: 'HS256', typ: 'JWT' }),
    encode({ sub: TEST_USER.id, email: TEST_USER.email, role: 'authenticated', exp }),
    'fake-signature',
  ].join('.')
}

function buildAuthUser() {
  return {
    id: TEST_USER.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: TEST_USER.email,
    email_confirmed_at: '2026-01-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
    app_metadata: { provider: 'email' },
    user_metadata: {},
  }
}

function buildSession() {
  return {
    access_token: buildAccessToken(),
    refresh_token: 'fake-refresh-token',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: buildAuthUser(),
  }
}

// One trader ranked in every period, so a test can switch period on its profile.
export const SHARED_TRADER_ROI = { '7D': 111, '30D': 222, '90D': 333 }

function buildSharedRow(period, nowIso) {
  return {
    ...buildRow(period, TRADERS_PER_PERIOD, nowIso),
    source: 'binance_futures',
    source_type: 'futures',
    source_trader_id: 'e2e-shared',
    handle: 'E2E Shared Trader',
    roi: SHARED_TRADER_ROI[period],
  }
}

export function buildFixtures(now = new Date()) {
  const nowIso = now.toISOString()
  const ranked = PERIODS.flatMap((period) => [
    ...Array.from({ length: TRADERS_PER_PERIOD }, (_, index) => buildRow(period, index, nowIso)),
    buildSharedRow(period, nowIso),
  ])
  const freshness = PERIODS.flatMap((season_id) =>
    ['binance_futures', 'hyperliquid'].map((source) => ({
      season_id,
      source,
      source_as_of: nowIso,
    }))
  )
  return {
    public_ranked_leaderboard: ranked,
    leaderboard_ranks: ranked,
    leaderboard_source_freshness: freshness,
    user_profiles: [
      {
        id: TEST_USER.id,
        handle: 'e2e_user',
        email: TEST_USER.email,
        banned_at: null,
        deleted_at: null,
      },
    ],
    trader_sources: ranked.map((row) => ({
      source: row.source,
      source_trader_id: row.source_trader_id,
      handle: row.handle,
      avatar_url: null,
      is_active: true,
    })),
  }
}

function parseList(text) {
  return text
    .replace(/^\(|\)$/g, '')
    .split(',')
    .map((item) => item.replace(/^"|"$/g, ''))
}

// PostgREST filter syntax: `column=op.value`, optionally `not.op.value`.
function matches(row, column, expression) {
  const negated = expression.startsWith('not.')
  const body = negated ? expression.slice(4) : expression
  const dot = body.indexOf('.')
  const op = body.slice(0, dot)
  const value = body.slice(dot + 1)
  const cell = row[column]
  let result
  switch (op) {
    case 'eq':
      result = String(cell) === value
      break
    case 'neq':
      result = String(cell) !== value
      break
    case 'gt':
      result = cell > (typeof cell === 'number' ? Number(value) : value)
      break
    case 'gte':
      result = cell >= (typeof cell === 'number' ? Number(value) : value)
      break
    case 'lt':
      result = cell < (typeof cell === 'number' ? Number(value) : value)
      break
    case 'lte':
      result = cell <= (typeof cell === 'number' ? Number(value) : value)
      break
    case 'in':
      result = parseList(value).includes(String(cell))
      break
    case 'is':
      result = value === 'null' ? cell == null : String(cell) === value
      break
    case 'ilike':
    case 'like': {
      const needle = value.replace(/[%*]/g, '').toLowerCase()
      result = String(cell ?? '')
        .toLowerCase()
        .includes(needle)
      break
    }
    default:
      // An unknown operator must not silently look like a match.
      result = false
  }
  return negated ? !result : result
}

// `or=(handle.ilike.%x%,id.eq.y)`; values with commas are not used by the app.
function matchesAny(row, expression) {
  return parseList(expression).some((term) => {
    const dot = term.indexOf('.')
    return matches(row, term.slice(0, dot), term.slice(dot + 1))
  })
}

const RESERVED_PARAMS = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'])

export function queryRelation(rows, searchParams) {
  let result = rows.filter((row) =>
    [...searchParams.entries()].every(([key, value]) => {
      if (RESERVED_PARAMS.has(key)) return true
      return key === 'or' ? matchesAny(row, value) : matches(row, key, value)
    })
  )

  const order = searchParams.get('order')
  if (order) {
    const terms = order.split(',').map((term) => {
      const [column, direction] = term.split('.')
      return { column, sign: direction === 'desc' ? -1 : 1 }
    })
    result = [...result].sort((a, b) => {
      for (const { column, sign } of terms) {
        if (a[column] === b[column]) continue
        return a[column] > b[column] ? sign : -sign
      }
      return 0
    })
  }

  const offset = Number(searchParams.get('offset') ?? 0)
  const limit = searchParams.has('limit') ? Number(searchParams.get('limit')) : result.length
  return result.slice(offset, offset + limit)
}

// Relations a test can write to. Everything else accepts a write and forgets it.
const WRITABLE_RELATIONS = new Set(['trader_watchlist'])

export function startFakeSupabase({ port = 54399, log } = {}) {
  const stored = new Map([...WRITABLE_RELATIONS].map((relation) => [relation, []]))
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fake-supabase.local')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', '*')
    res.setHeader('Access-Control-Allow-Methods', '*')
    res.setHeader('Access-Control-Expose-Headers', 'content-range')
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const send = (status, body) => {
      if (log) appendFileSync(log, `${status} ${req.method} ${req.url}\n`)
      res.setHeader('Content-Type', 'application/json')
      res.writeHead(status)
      res.end(status === 204 || req.method === 'HEAD' ? undefined : JSON.stringify(body))
    }

    const readBody = (handler) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => handler(body ? JSON.parse(body) : null))
    }

    const rest = url.pathname.match(/^\/rest\/v1\/([^/]+)$/)
    if (rest && stored.has(rest[1])) {
      const rows = stored.get(rest[1])
      if (req.method === 'POST') {
        return readBody((body) => {
          for (const row of [body].flat()) {
            const key = JSON.stringify([row.user_id, row.source, row.source_trader_id])
            const same = (other) =>
              JSON.stringify([other.user_id, other.source, other.source_trader_id]) === key
            if (!rows.some(same)) {
              rows.push({ id: rows.length + 1, created_at: new Date().toISOString(), ...row })
            }
          }
          send(201, [])
        })
      }
      if (req.method === 'DELETE') {
        const removed = new Set(queryRelation(rows, url.searchParams))
        stored.set(
          rest[1],
          rows.filter((row) => !removed.has(row))
        )
        return send(204, [])
      }
    }
    if (rest && (req.method === 'GET' || req.method === 'HEAD')) {
      // Fixtures are rebuilt per request so `computed_at` never ages out of
      // the app's freshness window during a long run.
      const source = stored.get(rest[1]) ?? buildFixtures()[rest[1]] ?? []
      const rows = queryRelation(source, url.searchParams)
      res.setHeader('Content-Range', `0-${Math.max(rows.length - 1, 0)}/${rows.length}`)
      const wantsObject = (req.headers.accept ?? '').includes('vnd.pgrst.object')
      if (!wantsObject) return send(200, rows)
      if (rows.length === 1) return send(200, rows[0])
      return send(406, { code: 'PGRST116', message: 'expected one row', details: null, hint: null })
    }
    // Upstash REST: production requires it at boot, so answer as an empty Redis.
    if (url.pathname === '/upstash') return send(200, { result: null })
    if (url.pathname === '/upstash/pipeline' || url.pathname === '/upstash/multi-exec') {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () =>
        send(
          200,
          JSON.parse(body).map(() => ({ result: null }))
        )
      )
      return
    }
    if (url.pathname === '/auth/v1/token') {
      return readBody((body) => {
        const refresh = url.searchParams.get('grant_type') === 'refresh_token'
        const valid =
          refresh || (body?.email === TEST_USER.email && body?.password === TEST_USER.password)
        if (valid) return send(200, buildSession())
        send(400, {
          code: 400,
          error_code: 'invalid_credentials',
          msg: 'Invalid login credentials',
        })
      })
    }
    if (url.pathname === '/auth/v1/user') {
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '')
      const signedIn = token.split('.').length === 3 && token.endsWith('fake-signature')
      return signedIn ? send(200, buildAuthUser()) : send(401, { code: 401, msg: 'invalid token' })
    }
    if (url.pathname.startsWith('/auth/v1/')) return send(204, {})
    return send(200, [])
  })

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.FAKE_SUPABASE_PORT || 54399)
  await startFakeSupabase({ port, log: process.env.FAKE_SUPABASE_LOG })
  console.log(`fake-supabase listening on 127.0.0.1:${port}`)
}
