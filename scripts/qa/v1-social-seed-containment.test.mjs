import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const packageJson = readFileSync(resolve(ROOT, 'package.json'), 'utf8')
const progress = readFileSync(resolve(ROOT, 'docs/PROGRESS.md'), 'utf8')
const runbook = readFileSync(resolve(ROOT, 'docs/RUNBOOK.md'), 'utf8')
const seedScripts = ['scripts/seed-quality-content.ts', 'scripts/social-seed/generate-posts.ts']

const forbiddenRuntimeSyntax =
  /\bimport\b|\brequire\s*\(|process\.env|process\.argv|\bfetch\s*\(|\b(?:supabase|createClient|postgres|database|dotenv|coingecko)\b|\b(?:readFile|writeFile|appendFile|unlink|rm)\w*\s*\(|\.from\s*\(|\.insert\s*\(|\.update\s*\(|\.delete\s*\(/i

function runSeedScript(script, args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {},
    timeout: 5000,
  })
}

test('V1 social seed CLI paths are inert compatibility tombstones', () => {
  const invocationSets = [[], ['--execute'], ['--cleanup'], ['100', '--unexpected-legacy-flag']]

  for (const script of seedScripts) {
    const source = readFileSync(resolve(ROOT, script), 'utf8')
    const filename = script.split('/').at(-1)

    assert.match(source, new RegExp(`\\[RETIRED\\].*${filename}`, 'u'))
    assert.match(source, /process\.exitCode\s*=\s*2\b/)
    assert.doesNotMatch(source, forbiddenRuntimeSyntax)

    for (const args of invocationSets) {
      const result = runSeedScript(script, args)

      assert.equal(result.error, undefined, `${script} process must launch`)
      assert.equal(result.status, 2, `${script} must return exit 2 for every invocation`)
      assert.equal(result.stdout, '', `${script} must not write to stdout`)
      assert.match(result.stderr, /\[RETIRED\]/, `${script} must report retirement on stderr`)
    }
  }
})

test('social seed source boundary is documented and included by the unit sweep', () => {
  assert.match(packageJson, /"qa:sweep-unit":\s*"node --test scripts\/qa\/\*\.test\.mjs"/)

  for (const document of [progress, runbook]) {
    assert.match(document, /V1 social seed CLI source (?:containment|boundary)/)
    assert.match(document, /`scripts\/seed-quality-content\.ts`/)
    assert.match(document, /`scripts\/social-seed\/generate-posts\.ts`/)
    assert.match(document, /source-only/)
    assert.match(document, /posts\/comments|posts and comments/)
  }
})
