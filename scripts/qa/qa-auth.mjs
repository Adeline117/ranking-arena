/**
 * Shared QA-account auth helper — the ONLY sanctioned way to obtain a QA session.
 *
 * 根治 2026-07-01 事故（QA session 注入被服务端吊销 → 登录态扫描退化为匿名态）：
 * bootstrap-qa-session.mjs 与 schema-canary-sentinel.mjs 过去每次运行都 admin
 * 重置 QA 密码，而 GoTrue 的密码重置会吊销该账号**全部既存 session**。任何并发
 * 进程（7:30 sentinel cron、其他会话的 sweep）一重跑 bootstrap 就杀死正在使用中
 * 的 session，后续 /api/* 全部 401，整轮登录态扫描产生大规模伪 fail。
 *
 * 对策（两条根治线）：
 *   1. 密码持久化 — env `QA_TEST_PASSWORD`（或 .env.local）优先，其次
 *      `~/.arena-qa-password.json`（0600）。正常路径 = 纯 password-grant 登录，
 *      **绝不重置密码、绝不吊销任何人的 session**。
 *   2. 仅当所有持久化密码登录失败时才 fallback admin 重置，且重置必须在
 *      /tmp mkdir 互斥锁内串行（stale-PID 可窃取）——bootstrap、sentinel、
 *      sweep 的自动重跑全部走这一个通道，不再互相残杀。
 *
 * QA 账号：qa.button.test@arenafi.org（见 memory/qa-test-accounts.md）
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const QA_EMAIL = 'qa.button.test@arenafi.org'
export const QA_USER_ID = '1c533890-01e8-4c34-a895-657f389ab4b2'
export const QA_HANDLE = 'qa_button_test'
// Second QA account (2026-07-02) — for user-to-user write flows (A follows/
// comments-on B so a notification lands in a controlled QA inbox, never a real
// user). is_pro=false so it can also exercise the ProGate LOCKED branch.
export const QA_EMAIL_B = 'qa.button.test.b@arenafi.org'
export const QA_USER_ID_B = '09755b88-e0ea-4d47-be3a-1fffb6646649'
export const QA_HANDLE_B = 'qa_button_test_b'

// Account descriptor — password env + persisted-password file are per-account.
export const ACCOUNT_A = {
  email: QA_EMAIL,
  userId: QA_USER_ID,
  handle: QA_HANDLE,
  pwEnv: 'QA_TEST_PASSWORD',
  pwFile: path.join(os.homedir(), '.arena-qa-password.json'),
}
export const ACCOUNT_B = {
  email: QA_EMAIL_B,
  userId: QA_USER_ID_B,
  handle: QA_HANDLE_B,
  pwEnv: 'QA_TEST_PASSWORD_B',
  pwFile: path.join(os.homedir(), '.arena-qa-password-b.json'),
}

const LOCK_DIR = '/tmp/arena-qa-auth.lock.d'
const LOCK_DEADLINE_MS = 60_000
const FETCH_TIMEOUT_MS = 30_000

const tfetch = (url, init = {}) =>
  fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS) })

export function readEnv(name, { optional = false } = {}) {
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
  if (optional) return null
  throw new Error(`${name} not found in env or .env.local`)
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Atomic mkdir mutex（macOS 无 flock(1)，与 push-lock 同一模式）。
 * 持有者 PID 已死则窃取；60s 拿不到则抛错（宁可失败也不越过串行化）。
 */
export async function withQaAuthLock(fn) {
  const deadline = Date.now() + LOCK_DEADLINE_MS
  for (;;) {
    try {
      fs.mkdirSync(LOCK_DIR)
      fs.writeFileSync(path.join(LOCK_DIR, 'pid'), String(process.pid))
      break
    } catch {
      let holder = NaN
      try {
        holder = Number(fs.readFileSync(path.join(LOCK_DIR, 'pid'), 'utf8'))
      } catch {
        /* pid file not written yet or dir vanished */
      }
      if (Number.isFinite(holder) && holder > 0 && !pidAlive(holder)) {
        fs.rmSync(LOCK_DIR, { recursive: true, force: true })
        continue
      }
      if (Date.now() > deadline)
        throw new Error(`qa-auth lock timeout (${LOCK_DIR}, holder pid ${holder || '?'})`)
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
  try {
    return await fn()
  } finally {
    fs.rmSync(LOCK_DIR, { recursive: true, force: true })
  }
}

function persistedPassword(account) {
  try {
    return JSON.parse(fs.readFileSync(account.pwFile, 'utf8')).password || null
  } catch {
    return null
  }
}

function persistPassword(account, pw) {
  fs.writeFileSync(
    account.pwFile,
    JSON.stringify({ password: pw, updated_at: new Date().toISOString() }, null, 2),
    { mode: 0o600 }
  )
}

async function tryLogin(supaUrl, anon, pw, email) {
  if (!pw) return null
  const res = await tfetch(`${supaUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anon, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: pw }),
  })
  const body = await res.json().catch(() => null)
  return body?.access_token ? body : null
}

/** GET /auth/v1/user 的 HTTP status（200=session 存活；0=网络失败）。 */
export async function qaAuthStatus(supaUrl, anon, accessToken) {
  try {
    const res = await tfetch(`${supaUrl}/auth/v1/user`, {
      headers: { apikey: anon, Authorization: `Bearer ${accessToken}` },
    })
    return res.status
  } catch {
    return 0
  }
}

/**
 * 拿一个 QA session（GoTrue token response 全量对象）。
 * 正常路径纯 password-grant；密码全部失效才在互斥锁内 admin 重置（并持久化新密码）。
 */
export async function loginQa({
  supaUrl,
  anon,
  srk,
  log = (m) => console.log(m),
  account = ACCOUNT_A,
}) {
  const attemptAll = async () => {
    const seen = new Set()
    for (const pw of [readEnv(account.pwEnv, { optional: true }), persistedPassword(account)]) {
      if (!pw || seen.has(pw)) continue
      seen.add(pw)
      const s = await tryLogin(supaUrl, anon, pw, account.email)
      if (s) return s
    }
    return null
  }

  const direct = await attemptAll()
  if (direct) return direct

  return withQaAuthLock(async () => {
    // 等锁期间另一进程可能已重置并持久化了新密码 — 先重试再重置。
    const retry = await attemptAll()
    if (retry) return retry

    const envPw = readEnv(account.pwEnv, { optional: true })
    const pw = envPw || crypto.randomBytes(18).toString('base64')
    log(
      `⚠ qa-auth: 持久化密码登录失败 — admin 重置 QA 密码 [${account.email}]（该账号全部既存 session 将被吊销）`
    )
    const resetRes = await tfetch(`${supaUrl}/auth/v1/admin/users/${account.userId}`, {
      method: 'PUT',
      headers: { apikey: srk, Authorization: `Bearer ${srk}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    })
    if (!resetRes.ok)
      throw new Error(`QA 密码重置失败 ${resetRes.status}: ${await resetRes.text()}`)
    persistPassword(account, pw)
    const s = await tryLogin(supaUrl, anon, pw, account.email)
    if (!s) throw new Error('QA 登录失败（密码重置后 password grant 仍失败）')
    return s
  })
}
