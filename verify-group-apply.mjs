import 'dotenv/config'
import { execSync } from 'child_process'
import { readFileSync } from 'fs'
const B = 'https://www.arenafi.org'
const UA = 'Mozilla/5.0 (Macintosh) Chrome/120 arena-verify-longua'
const U = process.env.NEXT_PUBLIC_SUPABASE_URL,
  SK = process.env.SUPABASE_SERVICE_ROLE_KEY
const H = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' }
const OLD = 'b715ed346'
async function liveSha() {
  try {
    return execSync(
      'env -u GITHUB_TOKEN -u GH_TOKEN gh api repos/{owner}/{repo}/deployments?per_page=1 --jq ".[0].sha[0:9]" 2>/dev/null',
      { encoding: 'utf8' }
    ).trim()
  } catch {
    return '?'
  }
}
// wait for deploy (dpl hash change) up to ~25min
async function dpl() {
  try {
    return ((await (await fetch(B + '/', { headers: { 'User-Agent': UA } })).text()).match(
      /data-dpl-id="([^"]+)"/
    ) || [, '?'])[1]
  } catch {
    return '?'
  }
}
const start = await dpl()
let cur = start,
  w = 0
while (w < 1500) {
  cur = await dpl()
  if (cur !== start && cur !== '?') {
    console.log('[deploy] new dpl', cur, '@' + w + 's')
    break
  }
  await new Promise((r) => setTimeout(r, 90000))
  w += 90
}
await new Promise((r) => setTimeout(r, 45000))
// bootstrap QA session → Bearer
let token = null
try {
  execSync('node scripts/qa/bootstrap-qa-session.mjs 2>/dev/null', { cwd: process.cwd() })
  const s = JSON.parse(readFileSync('/tmp/qa-session.json', 'utf8'))
  token = s.access_token || s.accessToken || s.token
} catch (e) {
  console.log('QA bootstrap failed:', e.message)
}
if (!token) {
  console.log('❌ no QA token — skipping apply test')
  process.exit(0)
}
const testName = 'ZZ_qa_apply_test_' + w
// POST apply
const res = await fetch(B + '/api/groups/apply', {
  method: 'POST',
  headers: {
    'User-Agent': UA,
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + token,
  },
  body: JSON.stringify({ name: testName, description: 'qa verification, safe to delete' }),
})
const body = await res.json().catch(() => ({}))
console.log('[apply] status', res.status, '| msg:', (body.message || body.error || '').slice(0, 60))
// check: no group auto-created + application is pending
await new Promise((r) => setTimeout(r, 1500))
const grp = await (
  await fetch(`${U}/rest/v1/groups?select=id&name=eq.${encodeURIComponent(testName)}`, {
    headers: H,
  })
).json()
const app = await (
  await fetch(
    `${U}/rest/v1/group_applications?select=id,status,group_id&name=eq.${encodeURIComponent(testName)}`,
    { headers: H }
  )
).json()
console.log(
  '[verify] 自动建群数(应0):',
  Array.isArray(grp) ? grp.length : '?',
  '| 申请状态(应pending):',
  app?.[0]?.status,
  '| group_id(应null):',
  app?.[0]?.group_id
)
const pass = Array.isArray(grp) && grp.length === 0 && app?.[0]?.status === 'pending'
// cleanup
if (app?.[0]?.id)
  await fetch(`${U}/rest/v1/group_applications?id=eq.${app[0].id}`, {
    method: 'DELETE',
    headers: H,
  })
if (Array.isArray(grp))
  for (const g of grp)
    await fetch(`${U}/rest/v1/groups?id=eq.${g.id}`, { method: 'DELETE', headers: H })
console.log('[cleanup] done')
console.log('=== VERDICT apply→pending:', pass ? 'PASS ✅' : 'FAIL ❌', '===')
