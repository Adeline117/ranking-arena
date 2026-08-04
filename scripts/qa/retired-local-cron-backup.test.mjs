import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const retiredJob = new URL('../cron/local-cron-backup.mjs', import.meta.url)
const setup = new URL('../cron/setup-local-cron.sh', import.meta.url)

test('the retired local cron cannot report backup or refresh success', async () => {
  const result = spawnSync(process.execPath, [retiredJob.pathname], { encoding: 'utf8' })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /RETIRED.*creates no backup.*refresh routes no longer exist/)
  assert.equal(result.stdout, '')

  const source = await readFile(retiredJob, 'utf8')
  assert.doesNotMatch(
    source,
    /createClient|trader_snapshots|unified-connector|scripts\/import\/refresh-all/
  )
  assert.doesNotMatch(source, /Completed|success: true/)
})

test('the setup helper refuses install and run while preserving uninstall', async () => {
  const source = await readFile(setup, 'utf8')
  assert.match(source, /install\|run\|now\)[\s\S]*retired/)
  assert.match(source, /uninstall\|remove\)[\s\S]*uninstall/)
  assert.doesNotMatch(source, /ProgramArguments|StartCalendarInterval|launchctl load/)

  for (const command of ['install', 'run', 'now']) {
    const result = spawnSync('/bin/bash', [setup.pathname, command], { encoding: 'utf8' })
    assert.equal(result.status, 2)
    assert.match(result.stderr, /RETIRED: local-cron-backup created no backup/)
  }
})
