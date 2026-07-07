import { chromium } from 'playwright'
const B = 'https://www.arenafi.org'
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36'
const OLD = 'dpl_66eQj6nRgJgsN7xPGzxjDbow1Dbh'
async function dpl() {
  try {
    const r = await fetch(B + '/', { headers: { 'User-Agent': UA } })
    const t = await r.text()
    return (t.match(/dpl_[A-Za-z0-9]+/) || ['?'])[0]
  } catch {
    return '?'
  }
}
// poll for new deploy up to ~22 min
let cur = OLD,
  waited = 0
while (waited < 1320) {
  cur = await dpl()
  if (cur !== OLD) {
    console.log(`[deploy] new dpl ${cur} after ${waited}s`)
    break
  }
  await new Promise((r) => setTimeout(r, 60000))
  waited += 60
}
if (cur === OLD) {
  console.log(
    `[deploy] STILL ${OLD} after ${waited}s — proceeding to test anyway (may be same-hash redeploy)`
  )
}
await new Promise((r) => setTimeout(r, 45000)) // propagation
const br = await chromium.launch({ headless: true })
const c = await br.newContext({ userAgent: UA })
const p = await c.newPage()
const api = []
p.on('request', (r) => {
  if (r.url().includes('/api/search?q='))
    api.push(decodeURIComponent(r.url().replace(B, '').slice(0, 55)))
})
// TEST A: land q=btc, retype hyperliquid -> results+url update
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
const urlA = await p.evaluate(() => location.href.replace('https://www.arenafi.org', ''))
console.log('A) retype: api=' + JSON.stringify(api) + ' url=' + urlA)
const gotHL = api.some((x) => x.includes('q=hyperliquid'))
console.log(
  'A) 结果更新到 hyperliquid:',
  gotHL,
  '| URL 含 hyperliquid:',
  urlA.includes('hyperliquid')
)
// TEST B: clear button
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
const urlB = await p.evaluate(() => location.href.replace('https://www.arenafi.org', ''))
console.log(
  'B) clear: clicked=' + cleared + ' url=' + urlB + ' (期望无 q=)',
  '| box=' + (await p.evaluate(() => [...document.querySelectorAll('input')].map((i) => i.value)))
)
// TEST C: fresh landing q=hyperliquid renders results
api.length = 0
await p
  .goto(B + '/search?q=hyperliquid&lang=zh', { waitUntil: 'networkidle', timeout: 45000 })
  .catch(() => {})
await p.waitForTimeout(3500)
console.log('C) 落地 q=hyperliquid: api=' + JSON.stringify(api))
console.log('=== VERDICT:', gotHL && urlA.includes('hyperliquid') ? 'PASS ✅' : 'FAIL ❌', '===')
await c.close()
await br.close()
