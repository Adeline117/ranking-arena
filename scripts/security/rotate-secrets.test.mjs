import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const scriptPath = join(root, 'scripts/security/rotate-secrets.sh')
const runbookPath = join(root, 'docs/RUNBOOK.md')

test('legacy generic secret rotator is executable but always fails closed', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'arena-retired-secret-rotation-'))
  const sentinel = 'ROTATION_TEST_VALUE_MUST_NOT_BE_ECHOED'

  try {
    const result = spawnSync(
      scriptPath,
      ['--service', 'telegram', `--accidental-value=${sentinel}`],
      {
        cwd: scratch,
        encoding: 'utf8',
        env: {
          PATH: '/usr/bin:/bin',
          ROTATION_TEST_ENV_SENTINEL: sentinel,
        },
      }
    )

    assert.equal(result.error, undefined)
    assert.equal(result.status, 2)
    assert.equal(result.signal, null)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /retired and fail-closed/)
    assert.match(result.stderr, /docs\/RUNBOOK\.md#manual-provider-atomic-secret-rotation/)
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(sentinel))
    assert.deepEqual(readdirSync(scratch), [])
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('retired entrypoint has no credential, provider, or local-env mutation path', () => {
  const source = readFileSync(scriptPath, 'utf8')

  assert.match(source, /^#!\/bin\/bash\n/)
  assert.match(source, /^RETIRED_EXIT_CODE=2$/m)
  assert.match(source, /^exit "\$RETIRED_EXIT_CODE"$/m)
  assert.doesNotMatch(source, /\bread\s+-/)
  assert.doesNotMatch(source, /\bopenssl\b/)
  assert.doesNotMatch(source, /\bvercel\s+env\b/)
  assert.doesNotMatch(source, /\bsed\s+-i\b/)
  assert.doesNotMatch(source, /\brotation-history\b/)
  assert.doesNotMatch(source, /(?:^|[^\\])\$(?:\*|@)/)
})

test('runbook requires a complete provider-atomic consumer handoff', () => {
  const runbook = readFileSync(runbookPath, 'utf8')
  const section = runbook.split('### Manual/provider-atomic secret rotation')[1]

  assert.ok(section, 'manual/provider-atomic rotation section must exist')
  assert.match(section, /退出码 `2` fail closed/)
  assert.match(section, /consumer manifest/)
  assert.match(section, /不得先删除仍在服务的旧值/)
  assert.match(section, /只有 manifest 全部通过后才在 provider 撤销旧版本/)
  assert.match(section, /不得退化成 delete-then-add/)
  assert.match(section, /不记录 secret 原文/)
})
