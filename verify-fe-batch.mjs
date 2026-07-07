import { chromium } from 'playwright'
import { execSync } from 'child_process'
const B = 'https://www.arenafi.org'
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36'
function sh(c) {
  try {
    return execSync(c, { encoding: 'utf8' })
  } catch (e) {
    return ''
  }
}
const OLD = 'dpl_F2CKhfUcU7kDWdBTiMWy8hDwUUwn'
// wait for a NEWER deploy (dpl changes) — the final code commit 3c9d88785 must ship
async function dpl() {
  try {
    const r = await fetch(B + '/', { headers: { 'User-Agent': UA } })
    return ((await r.text()).match(/data-dpl-id="([^"]+)"/) || [, '?'])[1]
  } catch {
    return '?'
  }
}
let cur = OLD,
  w = 0
while (w < 2400) {
  cur = await dpl()
  if (cur !== OLD && cur !== '?') {
    console.log(`[deploy] new dpl ${cur} @${w}s`)
    break
  }
  await new Promise((r) => setTimeout(r, 90000))
  w += 90
}
await new Promise((r) => setTimeout(r, 60000)) // settle
const br = await chromium.launch({ headless: true })
// resolve a real trader id
let tid = sh(
  `curl -s "https://www.arenafi.org/api/search?q=btc&limit=1" -H "User-Agent: ${UA}" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);const t=(j.data||j).results.traders[0];process.stdout.write((t.href||'').replace('/trader/','').split('?')[0])}catch{}})"`
).trim()
if (!tid) tid = 'yHCxHBEaJW5tbndqC8JciSThr7U1cqLpdcsvHcx6PRe'
console.log('trader id:', tid)
const pages = [
  ['首页', '/'],
  ['交易员详情', '/trader/' + tid + '?lang=zh'],
  ['市场', '/market?lang=zh'],
  ['群组', '/groups?lang=zh'],
  ['quiz', '/quiz?lang=zh'],
  ['定价', '/pricing?lang=zh'],
  ['搜索', '/search?q=btc&lang=zh'],
  ['个人主页', '/u/arena?lang=zh'],
  ['learn', '/learn?lang=zh'],
]
const c = await br.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } })
const p = await c.newPage()
let crash = 0
for (const [name, path] of pages) {
  const errs = []
  p.removeAllListeners('console')
  p.on('console', (m) => {
    if (m.type() === 'error') errs.push(m.text().slice(0, 60))
  })
  let status = 0
  const resp = await p
    .goto(B + path, { waitUntil: 'domcontentloaded', timeout: 45000 })
    .catch(() => null)
  status = resp ? resp.status() : 0
  await p.waitForTimeout(2500)
  const body = (await p.innerText('body').catch(() => '')) || ''
  const isCrash =
    /Application error|something went wrong|出错了|Unhandled|500 -/i.test(body) ||
    body.trim().length < 80
  if (isCrash || status >= 500) {
    crash++
    console.log(`❌ ${name} ${path} status=${status} crash=${isCrash} len=${body.length}`)
  } else console.log(`✅ ${name} status=${status} len=${body.length}`)
}
// spot checks
await p.goto(B + '/quiz?lang=zh', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {})
await p.waitForTimeout(2500)
const quizBody = await p.innerText('body').catch(() => '')
console.log(
  'SPOT U12-5 quiz zh: 含"Match a Legend"英文=' + /Match a Legend/i.test(quizBody) + '(期望false)'
)
await p
  .goto(B + '/market?lang=zh', { waitUntil: 'domcontentloaded', timeout: 45000 })
  .catch(() => {})
await p.waitForTimeout(3000)
const mktBody = await p.innerText('body').catch(() => '')
console.log('SPOT U7-9 market: 含"$0.0000"=' + /\$0\.0000/.test(mktBody) + '(期望false)')
console.log(`\n=== 渲染验证: ${pages.length - crash}/${pages.length} 页无崩溃 ===`)
await c.close()
await br.close()
