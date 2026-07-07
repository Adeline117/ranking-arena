import { chromium } from 'playwright'
import { execSync } from 'child_process'
const B = 'https://www.arenafi.org'
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36'
const OLD = 'dpl_DrYEJMSDRTNtXTeGEE5TDwrnprSR'
async function dpl() {
  try {
    const r = await fetch(B + '/', { headers: { 'User-Agent': UA } })
    const t = await r.text()
    return (t.match(/data-dpl-id="([^"]+)"/) || [, '?'])[1]
  } catch {
    return '?'
  }
}
// wait for dpl to change from OLD (= deploy-gate shipped my fix). up to ~35 min.
let cur = OLD,
  waited = 0
while (waited < 2100) {
  cur = await dpl()
  if (cur !== OLD && cur !== '?') {
    console.log(`[deploy] dpl changed → ${cur} after ${waited}s`)
    break
  }
  // also log CI status occasionally
  if (waited % 300 === 0) {
    try {
      const s = execSync('env -u GITHUB_TOKEN -u GH_TOKEN gh run list --limit 3 2>/dev/null', {
        encoding: 'utf8',
      })
      const ci = s.split('\n').find((l) => l.includes('U3-2') || l.includes('CI'))
      console.log(
        `[t+${waited}s] dpl=${cur.slice(0, 18)} CI: ${(ci || '').split('\t').slice(0, 2).join(' ')}`
      )
    } catch {}
  }
  await new Promise((r) => setTimeout(r, 90000))
  waited += 90
}
if (cur === OLD) {
  console.log('[deploy] dpl unchanged after 35min — deploy still pending, aborting test')
  process.exit(0)
}
await new Promise((r) => setTimeout(r, 50000)) // propagation
// behavior test
const br = await chromium.launch({ headless: true })
const c = await br.newContext({ userAgent: UA })
const p = await c.newPage()
const api = []
p.on('request', (r) => {
  if (r.url().includes('/api/search?q='))
    api.push(decodeURIComponent(r.url().replace(B, '').slice(0, 55)))
})
await p
  .goto(B + '/search?q=btc&lang=zh', { waitUntil: 'networkidle', timeout: 45000 })
  .catch(() => {})
await p.waitForTimeout(3500)
const box = (await p.$('input[value="btc"]')) || (await p.$$('input')).slice(-1)[0]
await box.click()
await box.press('Meta+A')
await box.press('Delete')
await box.type('hyperliquid', { delay: 70 })
await p.waitForTimeout(4500)
const url = await p.evaluate(() => location.href.replace('https://www.arenafi.org', ''))
const hl = api.some((x) => x.includes('q=hyperliquid'))
console.log(
  `[TEST] dpl=${cur.slice(0, 18)} 结果→hyperliquid=${hl} url=${url} api=${JSON.stringify(api)}`
)
// clear button test
const cleared = await p.evaluate(() => {
  const i = [...document.querySelectorAll('input')].find((x) => x.value === 'hyperliquid')
  const b = i?.parentElement?.querySelector('button')
  if (b) {
    b.click()
    return true
  }
  return false
})
await p.waitForTimeout(2500)
const url2 = await p.evaluate(() => location.href.replace('https://www.arenafi.org', ''))
console.log(`[TEST] clear: clicked=${cleared} url=${url2}(期望无q=)`)
console.log('=== VERDICT:', hl && url.includes('hyperliquid') ? 'PASS ✅' : 'FAIL ❌', '===')
await c.close()
await br.close()
