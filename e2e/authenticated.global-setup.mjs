import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ACCOUNT_A, loginQa, qaAuthStatus, readEnv } from '../scripts/qa/qa-auth.mjs'

const STATE_PATH = process.env.QA_STORAGE_STATE_PATH || '/tmp/arena-playwright-auth/qa-a.json'

export default async function authenticatedGlobalSetup() {
  const baseUrl = process.env.PLAYWRIGHT_BASE_URL || 'https://www.arenafi.org'
  const origin = new URL(baseUrl).origin
  const hostname = new URL(origin).hostname
  const supaUrl = readEnv('NEXT_PUBLIC_SUPABASE_URL')
  const anon = readEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY')
  const session = await loginQa({
    supaUrl,
    anon,
    srk: readEnv('SUPABASE_SERVICE_ROLE_KEY', { optional: true }) || '',
    account: ACCOUNT_A,
    allowPasswordReset: false,
    log: () => {},
  })

  if (session.user?.id !== ACCOUNT_A.userId) {
    throw new Error('QA-A login resolved to an unexpected account')
  }
  if ((await qaAuthStatus(supaUrl, anon, session.access_token)) !== 200) {
    throw new Error('QA-A session failed the Supabase read-back check')
  }

  const cookieDomain = hostname.endsWith('.arenafi.org') ? '.arenafi.org' : hostname
  const secure = origin.startsWith('https://')
  const authCookie = 'base64-' + Buffer.from(JSON.stringify(session), 'utf8').toString('base64url')
  const csrf = `${Date.now().toString(36)}.${crypto.randomBytes(32).toString('hex')}`
  const state = {
    cookies: [
      {
        name: 'sb-iknktzifjdyujdccyhsv-auth-token',
        value: authCookie,
        domain: cookieDomain,
        path: '/',
        expires: Math.floor(Date.now() / 1000) + 3600,
        httpOnly: false,
        secure,
        sameSite: 'Lax',
      },
      {
        name: 'csrf-token',
        value: csrf,
        domain: cookieDomain,
        path: '/',
        expires: Math.floor(Date.now() / 1000) + 3600,
        httpOnly: false,
        secure,
        sameSite: 'Lax',
      },
    ],
    origins: [
      {
        origin,
        localStorage: [{ name: 'arena-auth', value: JSON.stringify(session) }],
      },
    ],
  }

  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true, mode: 0o700 })
  fs.writeFileSync(STATE_PATH, JSON.stringify(state), { mode: 0o600 })

  // Playwright launches test workers after global setup, so these short-lived
  // values are inherited without writing them into the repository or reports.
  process.env.QA_ACCESS_TOKEN = session.access_token
  process.env.QA_EXPECTED_USER_ID = ACCOUNT_A.userId
}
