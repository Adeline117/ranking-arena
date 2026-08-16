import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const root = process.cwd()
const retiredScripts = [
  'arena-status-check.mjs',
  'backfill-risk-metrics-7d30d.ts',
  'backfill-sharpe-ratio.mjs',
  'backfill-window-24h.ts',
  'check-data-distribution.mjs',
  'compute-leaderboard-local.mjs',
  'daily-checkpoint.mjs',
  'diagnose-enrichment.mjs',
  'generate-trader-bios.ts',
  'health-check.mjs',
  'pipeline-health-check.mjs',
  'validate-data.mjs',
  'vps-fetch-geoblocked.mjs',
  'vps-health-check.mjs',
]

const forbiddenRuntimeSyntax =
  /@supabase|createClient|dotenv|process\.env|child_process|fetch\(|\.from\(|\.rpc\(|\.upsert\(|\.insert\(|\.update\(|\.delete\(|exec(?:Sync)?\(|spawn(?:Sync)?\(|Telegram|trader_snapshots|trader_profiles_v2|readFileSync|writeFileSync/i

function runRetiredScript(script, invocationArgs) {
  // These tombstones intentionally contain JavaScript-only TypeScript syntax.
  // Run them directly so the proof does not depend on the tsx package being
  // present before the script can return its deliberate exit code.
  const args = [join('scripts', script), ...invocationArgs]
  return spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    env: {},
    timeout: 5000,
  })
}

test('legacy runtime paths are inert compatibility tombstones', () => {
  const invocationSets = [[], ['--force', '--dry-run'], ['--unexpected-legacy-flag']]

  for (const script of retiredScripts) {
    const source = readFileSync(join(root, 'scripts', script), 'utf8')
    assert.match(source, /\[RETIRED\]/, `${script} must identify itself as retired`)
    assert.match(source, /process\.exitCode = 2/, `${script} must return exit 2`)
    assert.match(source, new RegExp(script.replace('.', '\\.'), 'u'))
    assert.doesNotMatch(source, forbiddenRuntimeSyntax, `${script} must not retain runtime effects`)

    for (const invocationArgs of invocationSets) {
      const result = runRetiredScript(script, invocationArgs)
      assert.equal(result.error, undefined, `${script} process must launch`)
      assert.equal(result.status, 2, `${script} must return exit 2 for every argument set`)
      assert.equal(result.stdout, '', `${script} must not claim success on stdout`)
      assert.match(result.stderr, /\[RETIRED\]/, `${script} must report retirement on stderr`)
    }
  }
})
