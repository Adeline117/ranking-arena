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
const classifier = readFileSync(resolve(ROOT, 'lib/flash-news/classify.ts'), 'utf8')
const scripts = [
  'scripts/flash-news/collect.mjs',
  'scripts/flash-news/retranslate-all.mjs',
  'scripts/backfill-flash-news-classify.mjs',
  'scripts/backfill-flash-news-translate.mjs',
  'scripts/purge-flash-news-noncrypto.mjs',
  'scripts/dedup-hot-posts.mjs',
]

const forbiddenRuntimeSyntax =
  /\bimport\b|\brequire\s*\(|process\.env|process\.argv|\bfetch\s*\(|\b(?:openai|supabase|postgres|database|dotenv|gtx|rss|xml)\b|\b(?:readFile|writeFile|appendFile|unlink|rm)\w*\s*\(|\.from\s*\(|\.insert\s*\(|\.update\s*\(|\.delete\s*\(/i

function runScript(script, args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {},
    timeout: 5000,
  })
}

test('V1 standalone Flash News maintenance CLI paths are inert compatibility tombstones', () => {
  const invocationSets = [[], ['--apply', '--backup'], ['--unexpected-legacy-flag=value']]

  for (const script of scripts) {
    const source = readFileSync(resolve(ROOT, script), 'utf8')
    const filename = script.split('/').at(-1)

    assert.match(source, new RegExp(`\\[RETIRED\\].*${filename}`, 'u'))
    assert.match(source, /process\.exitCode\s*=\s*2\b/)
    assert.doesNotMatch(source, forbiddenRuntimeSyntax)

    for (const args of invocationSets) {
      const result = runScript(script, args)

      assert.equal(result.error, undefined, `${script} process must launch`)
      assert.equal(result.status, 2, `${script} must return exit 2 for every invocation`)
      assert.equal(result.stdout, '', `${script} must not write to stdout`)
      assert.match(result.stderr, /\[RETIRED\]/, `${script} must report retirement on stderr`)
    }
  }
})

test('Flash News CLI source boundary is documented, sweep-covered, and does not misdescribe the classifier caller', () => {
  assert.match(packageJson, /"qa:sweep-unit":\s*"node --test scripts\/qa\/\*\.test\.mjs"/)
  assert.doesNotMatch(classifier, /cron \+ the\s+backfill script/i)

  for (const document of [progress, runbook]) {
    assert.match(document, /V1 standalone Flash News CLI source (?:containment|boundary)/)
    assert.match(document, /`scripts\/flash-news\/collect\.mjs`/)
    assert.match(document, /`scripts\/flash-news\/retranslate-all\.mjs`/)
    assert.match(document, /`scripts\/backfill-flash-news-classify\.mjs`/)
    assert.match(document, /`scripts\/backfill-flash-news-translate\.mjs`/)
    assert.match(document, /`scripts\/purge-flash-news-noncrypto\.mjs`/)
    assert.match(document, /`scripts\/dedup-hot-posts\.mjs`/)
    assert.match(document, /`app\/api\/cron\/flash-news-fetch`/)
    assert.match(document, /source-only/)
  }
})
