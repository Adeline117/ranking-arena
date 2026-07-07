import { execSync } from 'child_process'
const SHA = '2d347fdfb'
function sh(c) {
  try {
    return execSync(c, { encoding: 'utf8' })
  } catch (e) {
    return (e.stdout || '') + (e.stderr || '')
  }
}
let runId = null,
  w = 0
while (w < 360 && !runId) {
  try {
    const runs = JSON.parse(
      sh(
        `env -u GITHUB_TOKEN -u GH_TOKEN gh run list --workflow=CI --limit 8 --json databaseId,headSha 2>/dev/null`
      )
    )
    const r = runs.find((x) => x.headSha.startsWith(SHA))
    if (r) runId = r.databaseId
  } catch {}
  if (!runId) {
    execSync('sleep 20')
    w += 20
  }
}
if (!runId) {
  console.log('no CI run for ' + SHA)
  process.exit(0)
}
console.log('CI run', runId)
let done = false,
  s = 0
while (!done && s < 1500) {
  const out = sh(`env -u GITHUB_TOKEN -u GH_TOKEN gh run view ${runId} 2>/dev/null`)
  const e2e = (out.split('\n').find((l) => /E2E Tests/i.test(l)) || '').trim()
  console.log(`[t+${s}s] e2e: ${e2e.slice(0, 55)}`)
  if (/✓ E2E Tests|✘ E2E Tests|X E2E Tests/.test(out)) {
    done = true
    console.log('\n=== E2E 结果 ===')
    console.log(e2e)
    // dump smoke pass/fail lines
    const jobLine = out.split('\n').find((l) => /E2E Tests.*ID [0-9]+/.test(l))
    const jid = jobLine && jobLine.match(/ID (\d+)/) ? jobLine.match(/ID (\d+)/)[1] : null
    if (jid) {
      const log = sh(`env -u GITHUB_TOKEN -u GH_TOKEN gh run view --job ${jid} --log 2>/dev/null`)
      const res = log
        .split('\n')
        .filter((l) => /smoke-critical-path.*(✓|✘)|passed|failed|flaky/.test(l))
        .slice(-8)
      console.log(res.map((l) => l.replace(/^.*Z\s*/, '').trim()).join('\n'))
    }
    break
  }
  execSync('sleep 60')
  s += 60
}
