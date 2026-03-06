/**
 * Cloudflare Bypass — Use stealth browser to solve CF challenges
 * Caches cookies to /tmp/arena-cookies/ for reuse
 */

import * as fs from 'fs'
import * as path from 'path'
import { createStealthBrowser, configurePage, navigateWithRetry, type StealthBrowserOptions } from './stealth-browser'
import type { CookieParam } from 'puppeteer'
import { logger } from '@/lib/logger'

const COOKIE_DIR = '/tmp/arena-cookies'

function ensureCookieDir() {
  if (!fs.existsSync(COOKIE_DIR)) {
    fs.mkdirSync(COOKIE_DIR, { recursive: true })
  }
}

function cookiePath(url: string): string {
  const host = new URL(url).hostname.replace(/\./g, '_')
  return path.join(COOKIE_DIR, `${host}.json`)
}

function loadCachedCookies(url: string): CookieParam[] | null {
  try {
    const fp = cookiePath(url)
    if (!fs.existsSync(fp)) return null
    const stat = fs.statSync(fp)
    // Expire cache after 30 minutes
    if (Date.now() - stat.mtimeMs > 30 * 60 * 1000) {
      fs.unlinkSync(fp)
      return null
    }
    return JSON.parse(fs.readFileSync(fp, 'utf-8'))
  } catch {
    return null
  }
}

function saveCookies(url: string, cookies: CookieParam[]) {
  ensureCookieDir()
  fs.writeFileSync(cookiePath(url), JSON.stringify(cookies, null, 2))
}

export interface BypassResult {
  cookies: CookieParam[]
  html: string
}

/**
 * Bypass Cloudflare protection on a URL.
 * Returns extracted cookies and page HTML.
 */
export async function bypassCloudflare(
  url: string,
  opts?: StealthBrowserOptions
): Promise<BypassResult> {
  // Try cached cookies first
  const cached = loadCachedCookies(url)

  const { browser, close } = await createStealthBrowser({
    timeoutMs: 90_000,
    ...opts,
  })

  try {
    const page = await browser.newPage()
    await configurePage(page)

    // If we have cached cookies, set them before navigating
    if (cached) {
      await page.setCookie(...cached)
    }

    await navigateWithRetry(page, url, { retries: 2, waitMs: 3000 })

    // Check if we hit a Cloudflare challenge page
    const content = await page.content()
    const isChallenged =
      content.includes('cf-challenge') ||
      content.includes('challenge-platform') ||
      content.includes('Just a moment') ||
      content.includes('Checking your browser')

    if (isChallenged) {
      logger.warn('[cf-bypass] Cloudflare challenge detected, waiting for resolution...')
      // Wait up to 30s for the challenge to resolve
      try {
        await page.waitForFunction(
          () => {
            const body = document.body?.innerText || ''
            return (
              !body.includes('Just a moment') &&
              !body.includes('Checking your browser') &&
              !document.querySelector('#challenge-running')
            )
          },
          { timeout: 30_000 }
        )
        // Extra settle time
        await new Promise((r) => setTimeout(r, 3000))
      } catch {
        logger.warn('[cf-bypass] Challenge did not resolve in 30s')
      }
    }

    const cookies = await page.cookies()
    const html = await page.content()

    // Save cookies for reuse
    const cookieParams: CookieParam[] = cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      httpOnly: c.httpOnly,
      secure: c.secure,
      ...(c.sameSite ? { sameSite: c.sameSite as CookieParam['sameSite'] } : {}),
    }))
    saveCookies(url, cookieParams)

    return { cookies: cookieParams, html }
  } finally {
    await close()
  }
}

/**
 * Extract cookies as a header string for use with fetch()
 */
export function cookiesToHeader(cookies: CookieParam[]): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ')
}

/**
 * Intercept API responses from a page navigation.
 * Useful for exchanges that load data via XHR after page load.
 */
export async function interceptApiResponses(
  url: string,
  urlPatterns: string[],
  opts?: StealthBrowserOptions & { maxWaitMs?: number }
): Promise<{ cookies: CookieParam[]; responses: Array<{ url: string; body: string }> }> {
  const { maxWaitMs = 30_000, ...browserOpts } = opts || {}
  const { browser, close } = await createStealthBrowser({
    timeoutMs: 90_000,
    ...browserOpts,
  })

  try {
    const page = await browser.newPage()
    await configurePage(page)

    const responses: Array<{ url: string; body: string }> = []

    // Set up response interception
    page.on('response', async (response) => {
      const respUrl = response.url()
      if (urlPatterns.some((p) => respUrl.includes(p))) {
        try {
          const body = await response.text()
          responses.push({ url: respUrl, body })
        } catch { /* response body unavailable */ }
      }
    })

    // Load cached cookies
    const cached = loadCachedCookies(url)
    if (cached) await page.setCookie(...cached)

    await navigateWithRetry(page, url, { retries: 2, waitMs: 5000 })

    // Wait for API responses to come in
    const deadline = Date.now() + maxWaitMs
    while (responses.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000))
    }

    const cookies = await page.cookies()
    const cookieParams: CookieParam[] = cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      httpOnly: c.httpOnly,
      secure: c.secure,
      ...(c.sameSite ? { sameSite: c.sameSite as CookieParam['sameSite'] } : {}),
    }))
    saveCookies(url, cookieParams)

    return { cookies: cookieParams, responses }
  } finally {
    await close()
  }
}
