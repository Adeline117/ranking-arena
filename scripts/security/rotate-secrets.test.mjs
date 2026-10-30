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
    assert.match(result.stderr, /docs\/RUNBOOK\.md#credential-rotation--v1-no-go--owner-only/)
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

test('runbook keeps credential rotation retired and owner-only', () => {
  const runbook = readFileSync(runbookPath, 'utf8')
  const section = runbook
    .split('### Credential rotation — V1 NO-GO / owner-only')[1]
    ?.split('\n### ')[0]

  assert.ok(section, 'credential rotation section must exist')
  assert.match(section, /rotate-secrets\.sh` is RETIRED and exits `2`/)
  assert.match(section, /complete consumer manifest/)
  assert.match(section, /not secret material/)
  assert.doesNotMatch(section, /delete-then-add|vercel env|openssl/)
})
