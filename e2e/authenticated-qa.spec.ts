/**
 * Authenticated runtime QA.
 *
 * Session creation lives in authenticated.global-setup.mjs. This suite is
 * deliberately read-only; reversible write lifecycles run immediately after
 * it through scripts/qa/controlled-write-sweep.mjs (QA-A ↔ QA-B + cleanup).
 */
import { expect, test } from '@playwright/test'

test.describe.configure({ mode: 'serial' })

function authHeaders() {
  const token = process.env.QA_ACCESS_TOKEN
  if (!token) throw new Error('authenticated global setup did not provide QA_ACCESS_TOKEN')
  return { Authorization: `Bearer ${token}` }
}

test('storageState resolves to the dedicated QA-A identity', async ({ page }) => {
  await page.goto('/settings', { waitUntil: 'domcontentloaded' })

  const storedUserId = await page.evaluate(() => {
    const raw = localStorage.getItem('arena-auth')
    return raw ? JSON.parse(raw)?.user?.id : null
  })

  expect(storedUserId).toBe(process.env.QA_EXPECTED_USER_ID)
  await expect(page).not.toHaveURL(/\/login(?:\?|$)/)
  await expect(page.locator('main')).toBeVisible()
})

test('authenticated APIs return real account data', async ({ request }) => {
  const headers = authHeaders()
  const [notifications, watchlist, subscription] = await Promise.all([
    request.get('/api/notifications', { headers }),
    request.get('/api/watchlist', { headers }),
    request.get('/api/subscription', { headers }),
  ])

  expect(notifications.status()).toBe(200)
  expect(watchlist.status()).toBe(200)
  expect(subscription.status()).toBe(200)

  const subscriptionBody = await subscription.json()
  expect(subscriptionBody.subscription?.userId).toBe(process.env.QA_EXPECTED_USER_ID)
  expect(subscriptionBody.subscription?.tier).toMatch(/^(free|pro|lifetime)$/)
})

test('B2C discovery reaches a live trader profile under auth', async ({ page, request }) => {
  const rankings = await request.get('/api/rankings?window=30d&limit=1')
  expect(rankings.status()).toBe(200)
  const body = await rankings.json()
  const trader = body.data?.traders?.[0]

  expect(trader?.trader_key).toBeTruthy()
  expect(trader?.platform).toBeTruthy()

  await page.goto(
    `/trader/${encodeURIComponent(trader.trader_key)}?platform=${encodeURIComponent(trader.platform)}`,
    { waitUntil: 'domcontentloaded' }
  )
  await expect(page).toHaveURL(/\/trader\//)
  await expect(page.locator('main')).toBeVisible()
  await expect(page.locator('body')).not.toContainText(/Application error|Internal Server Error/i)
})

test('saved and pricing surfaces preserve the authenticated session', async ({ page }) => {
  await page.goto('/saved', { waitUntil: 'domcontentloaded' })
  await expect(page).not.toHaveURL(/\/login(?:\?|$)/)
  await expect(page.locator('main')).toBeVisible()

  await page.goto('/pricing', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('body')).toContainText(/Free|Pro|Lifetime/i)
})
