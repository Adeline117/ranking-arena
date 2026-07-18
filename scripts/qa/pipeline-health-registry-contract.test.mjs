import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const source = readFileSync(join(process.cwd(), 'scripts/pipeline-health-check.mjs'), 'utf8')
const freshnessSection = source.slice(
  source.indexOf('async function checkDataFreshness()'),
  source.indexOf('// 2b. bot_snapshots')
)

test('pipeline health CLI trusts only the active-source freshness RPC', () => {
  assert.match(freshnessSection, /rpc\/get_platform_freshness/)
  assert.doesNotMatch(freshnessSection, /KNOWN_PLATFORMS|FRESHNESS_SKIP_PLATFORMS/)
  assert.doesNotMatch(freshnessSection, /trader_snapshots_v2/)
  assert.doesNotMatch(freshnessSection, /if \(!platform \|\| !latest\) continue/)
})

test('pipeline health CLI fails closed on blind or malformed freshness', () => {
  assert.match(freshnessSection, /if \(!res\.ok\)[\s\S]*throw new Error/)
  assert.match(freshnessSection, /!Array\.isArray\(rpcData\) \|\| rpcData\.length === 0/)
  assert.match(freshnessSection, /seenPlatforms\.has\(platform\)/)
  assert.match(freshnessSection, /ageHours == null \|\| ageHours >= CRITICAL_HOURS/)
  assert.match(freshnessSection, /catch \(err\)[\s\S]*throw err/)
})
