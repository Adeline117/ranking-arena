import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const packageJson = readFileSync(resolve(ROOT, 'package.json'), 'utf8')
const progress = readFileSync(resolve(ROOT, 'docs/PROGRESS.md'), 'utf8')
const runbook = readFileSync(resolve(ROOT, 'docs/RUNBOOK.md'), 'utf8')
const monitors = ['scripts/vps/health-ping.sh', 'scripts/vps/healthcheck.mjs']

const forbiddenRuntimeSyntax =
  /\bimport\b|\brequire\s*\(|process\.env|process\.argv|\b(?:curl|ping)\s+|\bTELEGRAM_|https?:\/\/|node:http|\b(?:fs|os|child_process)\b|exec(?:Sync)?\s*\(|spawn(?:Sync)?\s*\(|createServer\s*\(|\.listen\s*\(|\b(?:readFile|writeFile|appendFile|unlink|rm)\w*\s*\(/i

function runMonitor(monitor, args) {
  const executable = monitor.endsWith('.sh') ? '/bin/bash' : process.execPath
  return spawnSync(executable, [monitor, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {},
    timeout: 5000,
  })
}

test('V1 legacy VPS monitor paths are inert compatibility tombstones', () => {
  const invocationSets = [[], ['--force', '--dry-run'], ['--unexpected-legacy-flag=value']]

  for (const monitor of monitors) {
    const source = readFileSync(resolve(ROOT, monitor), 'utf8')
    const filename = monitor.split('/').at(-1)

    assert.match(source, new RegExp(`\\[RETIRED\\].*${filename}`, 'u'))
    assert.match(source, /process\.exitCode\s*=\s*2\b|exit 2/)
    assert.doesNotMatch(source, forbiddenRuntimeSyntax)
    if (monitor.endsWith('.sh')) {
      assert.notEqual(
        statSync(resolve(ROOT, monitor)).mode & 0o111,
        0,
        `${monitor} must stay executable`
      )
    }

    for (const args of invocationSets) {
      const result = runMonitor(monitor, args)

      assert.equal(result.error, undefined, `${monitor} process must launch`)
      assert.equal(result.status, 2, `${monitor} must return exit 2 for every invocation`)
      assert.equal(result.stdout, '', `${monitor} must not write to stdout`)
      assert.match(result.stderr, /\[RETIRED\]/, `${monitor} must report retirement on stderr`)
    }
  }
})

test('legacy VPS monitor source boundary is documented and included by the unit sweep', () => {
  assert.match(packageJson, /"qa:sweep-unit":\s*"node --test scripts\/qa\/\*\.test\.mjs"/)

  for (const document of [progress, runbook]) {
    assert.match(document, /V1 legacy VPS monitor source (?:containment|boundary)/)
    assert.match(document, /`scripts\/vps\/health-ping\.sh`/)
    assert.match(document, /`scripts\/vps\/healthcheck\.mjs`/)
    assert.match(document, /source-only/)
    assert.match(document, /OpenClaw|harness/)
  }
})
