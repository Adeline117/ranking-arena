/**
 * 生成 /tmp/qa-session.json — auth-button-sweep.mjs 的前置依赖。
 *
 * 流程（复用 scripts/openclaw/schema-canary-sentinel.mjs 的逻辑）：
 *   1. service role 重置 QA 账号随机密码（不持久化）
 *   2. password grant 登录拿 access_token/refresh_token/user
 *   3. 写出 /tmp/qa-session.json
 *
 * QA 账号：qa.button.test@arenafi.org（见 memory/qa-test-accounts.md）
 * 用法：node scripts/qa/bootstrap-qa-session.mjs
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const QA_EMAIL = 'qa.button.test@arenafi.org'
const QA_USER_ID = '1c533890-01e8-4c34-a895-657f389ab4b2'
const OUT = '/tmp/qa-session.json'
const FETCH_TIMEOUT_MS = 30_000

const tfetch = (url, init = {}) =>
  fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS) })

function readEnv(name) {
  if (process.env[name]) return process.env[name].replace(/^"|"$/g, '')
  for (const file of ['.env.local', '.env']) {
    try {
      const m = fs
        .readFileSync(path.join(process.cwd(), file), 'utf8')
        .split('\n')
        .find((l) => l.startsWith(`${name}=`))
      if (m) return m.slice(name.length + 1).replace(/^"|"$/g, '')
    } catch {
      /* file missing */
    }
  }
  throw new Error(`${name} not found in env or .env.local`)
}

async function main() {
  const SUPA_URL = readEnv('NEXT_PUBLIC_SUPABASE_URL')
  const SRK = readEnv('SUPABASE_SERVICE_ROLE_KEY')
  const ANON = readEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY')

  const pw = crypto.randomBytes(18).toString('base64')
  const resetRes = await tfetch(`${SUPA_URL}/auth/v1/admin/users/${QA_USER_ID}`, {
    method: 'PUT',
    headers: { apikey: SRK, Authorization: `Bearer ${SRK}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw }),
  })
  if (!resetRes.ok) throw new Error(`QA 密码重置失败 ${resetRes.status}: ${await resetRes.text()}`)

  const loginRes = await tfetch(`${SUPA_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: QA_EMAIL, password: pw }),
  })
  const session = await loginRes.json()
  if (!session.access_token)
    throw new Error(`QA 登录失败: ${JSON.stringify(session).slice(0, 200)}`)

  fs.writeFileSync(OUT, JSON.stringify(session, null, 2))
  console.log(`✓ ${OUT} created (user ${session.user?.email}, expires_in ${session.expires_in}s)`)
}

main().catch((e) => {
  console.error('✗ bootstrap failed:', e.message)
  process.exit(1)
})
