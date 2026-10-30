import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const script = 'scripts/monitor-enrichment.sh'
const source = readFileSync(resolve(ROOT, script), 'utf8')
const retiredRunbooks = ['scripts/DEPLOY_TO_VPS.md', 'scripts/ONCHAIN_ENRICHMENT_README.md'].map(
  (path) => ({ path, source: readFileSync(resolve(ROOT, path), 'utf8') })
)
const forbiddenLegacyCapabilitySyntax =
  /\b(?:psql|ps|pgrep|grep|tail|head|cat|less|more|find|awk|sed|env|export|source)\b|\b(?:DATABASE_URL|PGHOST|PGPORT|PGUSER|PGPASSWORD|POSTGRES(?:QL)?_URL)\b|\/(?:tmp|var\/log)(?:\/|$)|\b(?:log|logs|host|hostname|curl|wget|fetch|ssh|scp|nc|netcat|ping|dig)\b|https?:\/\/|\$[({A-Za-z_]/i
const forbiddenRunbookOperationalSyntax =
  /```|\b(?:ssh|scp|crontab|psql|DATABASE_URL)\b|https?:\/\/|\broot@|\/opt\/arena|\/var\/log|enrich-onchain\.sh/i

function runTombstone(args) {
  return spawnSync('/bin/bash', [script, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {},
    timeout: 5_000,
  })
}

test('enrichment monitor is an executable inert exit-2 tombstone', () => {
  assert.match(source, /\[RETIRED\] scripts\/monitor-enrichment\.sh/)
  assert.match(source, /^exit 2$/m)
  assert.doesNotMatch(source, forbiddenLegacyCapabilitySyntax)
  assert.notEqual(statSync(resolve(ROOT, script)).mode & 0o111, 0, `${script} must stay executable`)

  for (const args of [[], ['--legacy', '--force'], ['platform=ignored', 'period=90D']]) {
    const result = runTombstone(args)

    assert.equal(result.error, undefined, `${script} must launch`)
    assert.equal(result.status, 2, `${script} must exit 2 for every invocation`)
    assert.equal(result.stdout, '', `${script} must keep stdout empty`)
    assert.equal(
      result.stderr,
      '[RETIRED] scripts/monitor-enrichment.sh\n',
      `${script} must only report its retirement on stderr`
    )
  }
})

test('retired enrichment runbooks cannot restore the removed operational recipe', () => {
  for (const runbook of retiredRunbooks) {
    assert.match(runbook.source, /`scripts\/monitor-enrichment\.sh`/, runbook.path)
    assert.match(runbook.source, /`scripts\/enrich-onchain-all\.mjs`/, runbook.path)
    assert.match(runbook.source, /source-only/i, runbook.path)
    assert.match(
      runbook.source,
      /not an operating procedure|cannot be used to restore/i,
      runbook.path
    )
    assert.match(runbook.source, /deployed (?:host|state)/i, runbook.path)
    assert.doesNotMatch(runbook.source, forbiddenRunbookOperationalSyntax, runbook.path)
  }
})
