import { chromium } from 'playwright'
const B = 'https://www.arenafi.org'
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36'
async function testRetype(br) {
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
  const dpl = await p.evaluate(() => document.documentElement.getAttribute('data-dpl-id') || '?')
  const hl = api.some((x) => x.includes('q=hyperliquid'))
  await c.close()
  return { hl, url, api, dpl }
}
const br = await chromium.launch({ headless: true })
let pass = false
for (let i = 0; i < 11; i++) {
  const r = await testRetype(br)
  console.log(
    `[iter ${i}] dpl=${r.dpl.slice(0, 20)} 结果→hyperliquid=${r.hl} url=${r.url} api=${JSON.stringify(r.api)}`
  )
  if (r.hl && r.url.includes('hyperliquid')) {
    pass = true
    console.log('=== PASS ✅ retype 更新结果+URL ===')
    break
  }
  if (i < 10) {
    await new Promise((res) => setTimeout(res, 120000))
  }
}
if (!pass) console.log('=== 仍 FAIL ❌ after polling — 需进一步排查 ===')
await br.close()
