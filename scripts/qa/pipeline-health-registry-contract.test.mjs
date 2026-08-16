import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const source = readFileSync(join(process.cwd(), 'scripts/pipeline-health-check.mjs'), 'utf8')

test('retired pipeline health CLI cannot inspect, repair, or report legacy state', () => {
  assert.match(source, /\[RETIRED\]/)
  assert.match(source, /process\.exitCode = 2/)
  assert.doesNotMatch(
    source,
    /createClient|@supabase\/supabase-js|child_process|fetch\(|\.from\(|\.rpc\(/
  )
  assert.doesNotMatch(source, /auto-fix|Telegram|trader_snapshots/)
})
