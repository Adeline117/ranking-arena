import { execSync } from 'child_process'
const SHA = '5a4d81c5f'
function sh(c) {
  try {
    return execSync(c, { encoding: 'utf8' })
  } catch (e) {
    return (e.stdout || '') + (e.stderr || '')
  }
}
let runId = null,
  waited = 0
// find the CI run for our SHA
while (waited < 300 && !runId) {
  const out = sh(
    `env -u GITHUB_TOKEN -u GH_TOKEN gh run list --workflow=CI --limit 8 --json databaseId,headSha,status 2>/dev/null`
  )
  try {
    const runs = JSON.parse(out)
    const r = runs.find((x) => x.headSha.startsWith(SHA))
    if (r) runId = r.databaseId
  } catch {}
  if (!runId) {
    execSync('sleep 20')
    waited += 20
  }
}
if (!runId) {
  console.log('CI run for ' + SHA + ' not found after 5min')
  process.exit(0)
}
console.log('CI run id:', runId)
// poll the e2e job specifically until CI completes
let done = false,
  secs = 0
while (!done && secs < 1500) {
  const out = sh(`env -u GITHUB_TOKEN -u GH_TOKEN gh run view ${runId} 2>/dev/null`)
  const e2eLine = (out.split('\n').find((l) => /E2E Tests/i.test(l)) || '').trim()
  const overall = (out.split('\n').find((l) => /main CI ·/.test(l)) || '').trim()
  console.log(`[t+${secs}s] ${overall} | e2e: ${e2eLine.slice(0, 60)}`)
  if (/✓ E2E Tests|✘ E2E Tests|X E2E Tests/.test(out) || /^(✓|X) main CI/.test(overall)) {
    done = true
    break
  }
  execSync('sleep 60')
  secs += 60
}
console.log('=== final ===')
console.log(
  sh(`env -u GITHUB_TOKEN -u GH_TOKEN gh run view ${runId} 2>/dev/null`)
    .split('\n')
    .slice(0, 14)
    .join('\n')
)
