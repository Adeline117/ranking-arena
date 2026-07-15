#!/usr/bin/env node
/**
 * B5: Verify the free-user ProGate in a Preview deployment where
 * NEXT_PUBLIC_PRO_FREE_PROMO=false. Uses only QA-B (known free tier) and performs no
 * database writes: /compare must show the inline gate and its CTA must lead
 * to /pricing.
 *
 * Run:
 *   BASE_URL=https://<preview>.vercel.app node scripts/qa/pro-gate-preview.mjs
 *
 * If the Preview project has Vercel Deployment Protection enabled, also set
 * VERCEL_AUTOMATION_BYPASS_SECRET. The secret is sent only as Vercel's
 * protection-bypass request header and is never printed.
 */
import crypto from 'node:crypto'
import { chromium } from 'playwright'
import { ACCOUNT_B, loginQa, qaAuthStatus, readEnv } from './qa-auth.mjs'

const BASE = process.env.BASE_URL
if (!BASE) throw new Error('BASE_URL must point to a Preview deployment')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function main() {
  const supaUrl = readEnv('NEXT_PUBLIC_SUPABASE_URL')
  const anon = readEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY')
  const srk = readEnv('SUPABASE_SERVICE_ROLE_KEY')
  const session = await loginQa({ supaUrl, anon, srk, account: ACCOUNT_B })
  assert(session.user?.id === ACCOUNT_B.userId, 'QA-B session resolved to an unexpected account')
  assert(
    (await qaAuthStatus(supaUrl, anon, session.access_token)) === 200,
    'QA-B session preflight failed'
  )

  const browser = await chromium.launch({ headless: true })
  try {
    const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      ...(bypassSecret
        ? {
            extraHTTPHeaders: {
              'x-vercel-protection-bypass': bypassSecret,
              // Persist the bypass through browser navigations and assets.
              'x-vercel-set-bypass-cookie': 'true',
            },
          }
        : {}),
    })
    await context.addInitScript((savedSession) => {
      localStorage.setItem('arena-auth', JSON.stringify(savedSession))
    }, session)

    const host = new URL(BASE).hostname
    const cookieDomain = host === 'localhost' ? 'localhost' : '.vercel.app'
    const projectRef = 'iknktzifjdyujdccyhsv'
    const csrf = `${Date.now().toString(36)}.${crypto.randomBytes(32).toString('hex')}`
    await context.addCookies([
      {
        name: `sb-${projectRef}-auth-token`,
        value: encodeURIComponent(JSON.stringify(session)),
        domain: cookieDomain,
        path: '/',
      },
      {
        name: `sb-${projectRef}-auth-token.0`,
        value: Buffer.from(JSON.stringify(session)).toString('base64'),
        domain: cookieDomain,
        path: '/',
      },
      { name: 'csrf-token', value: csrf, domain: cookieDomain, path: '/' },
    ])

    const page = await context.newPage()
    await page.goto(`${BASE}/compare`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForTimeout(3_000)

    const gate = page.getByText('Compare up to 5 traders side by side', { exact: true })
    try {
      await gate.waitFor({ state: 'visible', timeout: 10_000 })
    } catch (error) {
      // Keep a failed Preview acceptance diagnosable without emitting secrets
      // or a full authenticated page. This distinguishes a Vercel login wall,
      // a lost QA session, and a missing gate configuration.
      const body = (
        await page
          .locator('body')
          .innerText()
          .catch(() => '')
      )
        .replace(/\s+/g, ' ')
        .slice(0, 300)
      throw new Error(
        `Compare gate did not render (url=${page.url()}, title=${await page.title()}, body=${JSON.stringify(body)}): ${error instanceof Error ? error.message : String(error)}`
      )
    }
    const cta = page.getByRole('button', { name: 'Start 7-Day Free Trial' })
    await cta.waitFor({ state: 'visible', timeout: 5_000 })
    await cta.click()
    await page.waitForURL(/\/pricing(?:\?|$)/, { timeout: 10_000 })

    process.stdout.write(
      `${JSON.stringify({
        pass: true,
        qa_user: ACCOUNT_B.handle,
        base: BASE,
        gate: 'inline compare ProGate',
        cta_destination: new URL(page.url()).pathname,
      })}\n`
    )
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(
    `FAIL preview ProGate acceptance: ${error instanceof Error ? error.message : String(error)}`
  )
  process.exitCode = 1
})
