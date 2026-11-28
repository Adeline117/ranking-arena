import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  LAUNCH_MIGRATION_INVENTORY_CONTRACT,
  LAUNCH_MIGRATION_INVENTORY_STATUS,
  LAUNCH_MIGRATION_PHASES,
  LAUNCH_RUNNER_READONLY_ARRAYS,
  buildLaunchMigrationInventory,
  parseMigrationArray,
} from './launch-migration-inventory.mjs'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const SCRIPT = resolve(ROOT, 'scripts/qa/launch-migration-inventory.mjs')

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex')
}

function fixture() {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'arena-launch-inventory-'))
  const runner = resolve(repoRoot, 'scripts/maintenance/apply-launch-migrations.sh')
  const migrations = resolve(repoRoot, 'supabase/migrations')
  mkdirSync(dirname(runner), { recursive: true })
  mkdirSync(migrations, { recursive: true })
  writeFileSync(
    runner,
    'FIXTURE_MIGRATIONS=(\n  20260804000000_fixture.sql\n)\nreadonly -a FIXTURE_MIGRATIONS\n'
  )
  writeFileSync(resolve(migrations, '20260804000000_fixture.sql'), 'SELECT 1;\n')
  return { migrations, repoRoot }
}

function canonicalFixtureRunner(tipReadonlyDeclaration) {
  const phaseArrays = LAUNCH_MIGRATION_PHASES.map(
    ({ sourceArray }) =>
      `${sourceArray}=(\n  20260804000000_fixture.sql\n)\nreadonly -a ${sourceArray}\n`
  ).join('\n')
  return `${phaseArrays}\nTIP_CHECKOUT_CUTOVER_VERSIONS=(\n  20260721210000\n)\n${tipReadonlyDeclaration}`
}

test('exports a deterministic, hash-attested read-only launch inventory', () => {
  const first = buildLaunchMigrationInventory({ repoRoot: ROOT })
  const second = buildLaunchMigrationInventory({ repoRoot: ROOT })
  assert.deepEqual(first, second)
  assert.equal(first.contract, LAUNCH_MIGRATION_INVENTORY_CONTRACT)
  assert.equal(first.status, LAUNCH_MIGRATION_INVENTORY_STATUS)
  assert.match(first.inventorySha256, /^[a-f0-9]{64}$/u)
  const predeploy = first.phases.find((phase) => phase.name === 'predeploy')
  const postdeploy = first.phases.find((phase) => phase.name === 'postdeploy')
  assert.equal(predeploy.count, 161)
  assert.equal(postdeploy.count, 45)
  const firstMigration = predeploy.migrations[0]
  assert.equal(firstMigration.sha256, sha256(readFileSync(resolve(ROOT, firstMigration.path))))
  assert.equal(
    firstMigration.ledgerStatementsSha256,
    sha256(
      JSON.stringify({
        kind: 'sql-statements',
        value: [readFileSync(resolve(ROOT, firstMigration.path), 'utf8')],
      })
    )
  )
  assert.equal(firstMigration.name, firstMigration.file.replace(/^\d{14}_|\.sql$/gu, ''))
})

test('array parser rejects duplicates, malformed entries, mutation, and unterminated arrays', () => {
  assert.deepEqual(
    parseMigrationArray('FILES=(\n  20260804000000_one.sql\n)\nreadonly -a FILES\n', 'FILES'),
    ['20260804000000_one.sql']
  )
  assert.throws(
    () =>
      parseMigrationArray(
        'FILES=(\n  20260804000000_one.sql\n  20260804000000_one.sql\n)\nreadonly -a FILES\n',
        'FILES'
      ),
    /duplicate migration/u
  )
  assert.throws(
    () =>
      parseMigrationArray("FILES=(\n  '20260804000000_one.sql'\n)\nreadonly -a FILES\n", 'FILES'),
    /unsupported entry/u
  )
  assert.throws(
    () => parseMigrationArray('FILES=(\n  20260804000000_one.sql\n', 'FILES'),
    /not terminated/u
  )
  for (const mutation of [
    'FILES=(\n  20260804000000_two.sql\n)\n',
    'FILES+=(20260804000000_two.sql)\n',
    'FILES[0]=20260804000000_two.sql\n',
  ]) {
    assert.throws(
      () =>
        parseMigrationArray(
          `FILES=(\n  20260804000000_one.sql\n)\nreadonly -a FILES\n${mutation}`,
          'FILES'
        ),
      /one direct immutable declaration/u
    )
  }
  for (const mutation of [
    'unset FILES\n',
    'read -a FILES\n',
    'mapfile -t FILES < migrations.txt\n',
    'declare -n alias=FILES\n',
    'printf -v FILES[0] %s replacement\n',
    '((FILES[0]++))\n',
    'eval "$mutation"\n',
  ]) {
    assert.throws(
      () =>
        parseMigrationArray(
          `FILES=(\n  20260804000000_one.sql\n)\nreadonly -a FILES\n${mutation}`,
          'FILES'
        ),
      /must not be mutated/u
    )
  }

  const indirectMutations = [
    'name=FILES; read -a "$name"\n',
    'name=FILES; read -r "$name"\n',
    'name=FILES; builtin read -a "$name"\n',
    'name=FILES; readarray -t "$name"\n',
    'name=FILES; mapfile -t "$name"\n',
    'payload="FILES[0]=replacement"; eval "$payload"\n',
    'command eval "$payload"\n',
    'source ./array-mutator.sh\n',
    '. ./array-mutator.sh\n',
    'if true; then . ./array-mutator.sh; fi\n',
    'command . ./array-mutator.sh\n',
    'name=FILES; printf -v "$name[0]" %s replacement\n',
    'name=FILES; printf "-v" "$name[0]" %s replacement\n',
    'name=FILES; printf -v"$name[0]" %s replacement\n',
    'name=FILES; unset "$name[0]"\n',
    'name=FILES; declare -n alias="$name"\n',
    'name=FILES; typeset -n alias="$name"\n',
    'mutate() { local -n alias="$1"; alias[0]=replacement; }; mutate FILES\n',
    'mutate() { local "-n" alias="$1"; alias[0]=replacement; }; mutate FILES\n',
    'name=FILES; declare -a "$name"\n',
    'assignment="FILES[0]=replacement"; declare "$assignment"\n',
    'assignment="FILES[0]=replacement"; export "$assignment"\n',
    'name=FILES; readonly "$name"\n',
    'name=FILES; getopts a "$name"\n',
    'name=FILES; wait -p "$name" 123\n',
    'name=FILES; wait "-p" "$name" 123\n',
    'coproc FILES { printf ok; }\n',
    'for FILES in replacement; do :; done\n',
    'select FILES in replacement; do break; done\n',
    'name=FILES; (( ${name}[0]++ ))\n',
    'name=FILES; (( $name[0] += 1 ))\n',
    'name=FILES; (( ${name}[0] <<= 1 ))\n',
    '(( FILES[0] >>= 1 ))\n',
    'name=FILES; let "$name[0]++"\n',
    'name=FILES; trap \'read -a "$name"\' EXIT\n',
    'name=FILES; trap "$name[0]=replacement" DEBUG\n',
    'name=FILES; p\'r\'intf -v "$name" %s replacement\n',
    'name=FILES; p\\rintf -v "$name" %s replacement\n',
    'enable -n readonly\n',
  ]
  for (const mutation of indirectMutations) {
    assert.throws(
      () =>
        parseMigrationArray(
          `FILES=(\n  20260804000000_one.sql\n)\nreadonly -a FILES\n${mutation}`,
          'FILES'
        ),
      /must not be mutated indirectly/u,
      mutation
    )
  }

  assert.deepEqual(
    parseMigrationArray(
      `# read -a "$name" is inert documentation
FILES=(
  20260804000000_one.sql
)
readonly -a FILES
cat <<'DOC'
eval 'FILES[0]=replacement'
source ./array-mutator.sh
DOC
value=$(((ordinal + 1) * 2))
`,
      'FILES'
    ),
    ['20260804000000_one.sql']
  )
})

test('managed arrays require one exact adjacent readonly declaration', () => {
  const declaration = 'FILES=(\n  20260804000000_one.sql\n)\n'
  for (const invalid of [
    declaration,
    `${declaration}readonly FILES\n`,
    `${declaration}declare -ar FILES\n`,
    `${declaration}readonly -a OTHER_FILES\n`,
    `${declaration}\nreadonly -a FILES\n`,
    `${declaration}readonly -a FILES\nreadonly -a FILES\n`,
  ]) {
    assert.throws(
      () => parseMigrationArray(invalid, 'FILES'),
      /must have one exact readonly declaration immediately after its array/u,
      invalid
    )
  }

  const runner = readFileSync(
    resolve(ROOT, 'scripts/maintenance/apply-launch-migrations.sh'),
    'utf8'
  )
  for (const arrayName of LAUNCH_RUNNER_READONLY_ARRAYS) {
    assert.equal(
      [...runner.matchAll(new RegExp(`^readonly -a ${arrayName}$`, 'gmu'))].length,
      1,
      arrayName
    )
  }
})

test('runtime readonly and inventory checks close trap and quoted or escaped printf mutation', () => {
  const mutations = [
    'trap "$name[0]=20260804000000_two.sql" DEBUG',
    'p\'r\'intf -v "$name" %s 20260804000000_two.sql',
    'p\\rintf -v "$name" %s 20260804000000_two.sql',
  ]
  for (const mutation of mutations) {
    const mutable = spawnSync(
      'bash',
      ['-c', `FILES=(20260804000000_one.sql); name=FILES; ${mutation}; printf '%s' "\${FILES[0]}"`],
      { encoding: 'utf8' }
    )
    assert.equal(mutable.status, 0, mutable.stderr)
    assert.equal(mutable.stdout, '20260804000000_two.sql')

    const source = `FILES=(\n  20260804000000_one.sql\n)\nreadonly -a FILES\n` + `${mutation}\n`
    assert.throws(
      () => parseMigrationArray(source, 'FILES'),
      /must not be mutated indirectly after declaration/u,
      mutation
    )

    const immutable = spawnSync(
      'bash',
      [
        '-c',
        `set -Eeuo pipefail; FILES=(20260804000000_one.sql); readonly -a FILES; name=FILES; ${mutation}; printf unreachable`,
      ],
      { encoding: 'utf8' }
    )
    assert.notEqual(immutable.status, 0, mutation)
    assert.equal(immutable.stdout.includes('unreachable'), false, mutation)
  }
})

test('canonical runner contract also requires TIP checkout versions to be exactly readonly', () => {
  for (const invalidTipReadonly of [
    '',
    'readonly TIP_CHECKOUT_CUTOVER_VERSIONS\n',
    'readonly -a WRONG_TIP_VERSIONS\n',
    '\nreadonly -a TIP_CHECKOUT_CUTOVER_VERSIONS\n',
    'readonly -a TIP_CHECKOUT_CUTOVER_VERSIONS\nreadonly -a TIP_CHECKOUT_CUTOVER_VERSIONS\n',
  ]) {
    const setup = fixture()
    try {
      writeFileSync(
        resolve(setup.repoRoot, 'scripts/maintenance/apply-launch-migrations.sh'),
        canonicalFixtureRunner(invalidTipReadonly)
      )
      assert.throws(
        () => buildLaunchMigrationInventory({ repoRoot: setup.repoRoot }),
        /TIP_CHECKOUT_CUTOVER_VERSIONS must have one exact readonly declaration immediately after its array/u,
        invalidTipReadonly
      )
    } finally {
      rmSync(setup.repoRoot, { force: true, recursive: true })
    }
  }

  const setup = fixture()
  try {
    writeFileSync(
      resolve(setup.repoRoot, 'scripts/maintenance/apply-launch-migrations.sh'),
      canonicalFixtureRunner('readonly -a TIP_CHECKOUT_CUTOVER_VERSIONS\n')
    )
    assert.equal(buildLaunchMigrationInventory({ repoRoot: setup.repoRoot }).phases.length, 8)
  } finally {
    rmSync(setup.repoRoot, { force: true, recursive: true })
  }
})

test('inventory refuses missing and symlinked migration files', async (t) => {
  await t.test('missing', () => {
    const setup = fixture()
    try {
      rmSync(resolve(setup.migrations, '20260804000000_fixture.sql'))
      assert.throws(
        () =>
          buildLaunchMigrationInventory({
            phaseDefinitions: [{ name: 'fixture', sourceArray: 'FIXTURE_MIGRATIONS' }],
            repoRoot: setup.repoRoot,
          }),
        /does not exist/u
      )
    } finally {
      rmSync(setup.repoRoot, { force: true, recursive: true })
    }
  })
  await t.test('symlink', () => {
    const setup = fixture()
    const migration = resolve(setup.migrations, '20260804000000_fixture.sql')
    try {
      const target = resolve(setup.repoRoot, 'outside.sql')
      writeFileSync(target, 'SELECT 1;\n')
      rmSync(migration)
      symlinkSync(target, migration)
      assert.throws(
        () =>
          buildLaunchMigrationInventory({
            phaseDefinitions: [{ name: 'fixture', sourceArray: 'FIXTURE_MIGRATIONS' }],
            repoRoot: setup.repoRoot,
          }),
        /must be a regular file/u
      )
    } finally {
      rmSync(setup.repoRoot, { force: true, recursive: true })
    }
  })
  await t.test('symlinked migrations parent escaping the repository', () => {
    const setup = fixture()
    const externalRoot = mkdtempSync(resolve(tmpdir(), 'arena-launch-inventory-external-'))
    try {
      rmSync(setup.migrations, { recursive: true })
      writeFileSync(resolve(externalRoot, '20260804000000_fixture.sql'), 'SELECT 1;\n')
      symlinkSync(externalRoot, setup.migrations)
      assert.throws(
        () =>
          buildLaunchMigrationInventory({
            phaseDefinitions: [{ name: 'fixture', sourceArray: 'FIXTURE_MIGRATIONS' }],
            repoRoot: setup.repoRoot,
          }),
        /must not contain symlinked directories/u
      )
    } finally {
      rmSync(setup.repoRoot, { force: true, recursive: true })
      rmSync(externalRoot, { force: true, recursive: true })
    }
  })
  await t.test('symlinked runner parent escaping the repository', () => {
    const setup = fixture()
    const maintenance = resolve(setup.repoRoot, 'scripts/maintenance')
    const externalRoot = mkdtempSync(resolve(tmpdir(), 'arena-launch-runner-external-'))
    try {
      writeFileSync(
        resolve(externalRoot, 'apply-launch-migrations.sh'),
        'FIXTURE_MIGRATIONS=(\n  20260804000000_fixture.sql\n)\n'
      )
      rmSync(maintenance, { recursive: true })
      symlinkSync(externalRoot, maintenance)
      assert.throws(
        () =>
          buildLaunchMigrationInventory({
            phaseDefinitions: [{ name: 'fixture', sourceArray: 'FIXTURE_MIGRATIONS' }],
            repoRoot: setup.repoRoot,
          }),
        /must not contain symlinked directories/u
      )
    } finally {
      rmSync(setup.repoRoot, { force: true, recursive: true })
      rmSync(externalRoot, { force: true, recursive: true })
    }
  })
  await t.test('invalid UTF-8 migration body', () => {
    const setup = fixture()
    try {
      writeFileSync(resolve(setup.migrations, '20260804000000_fixture.sql'), Buffer.from([0xff]))
      assert.throws(
        () =>
          buildLaunchMigrationInventory({
            phaseDefinitions: [{ name: 'fixture', sourceArray: 'FIXTURE_MIGRATIONS' }],
            repoRoot: setup.repoRoot,
          }),
        /valid UTF-8 SQL/u
      )
    } finally {
      rmSync(setup.repoRoot, { force: true, recursive: true })
    }
  })
})

test('inventory refuses duplicate phase identities', () => {
  const setup = fixture()
  try {
    assert.throws(
      () =>
        buildLaunchMigrationInventory({
          phaseDefinitions: [
            { name: 'fixture', sourceArray: 'FIXTURE_MIGRATIONS' },
            { name: 'fixture', sourceArray: 'OTHER_MIGRATIONS' },
          ],
          repoRoot: setup.repoRoot,
        }),
      /phase name is duplicated/u
    )
    assert.throws(
      () =>
        buildLaunchMigrationInventory({
          phaseDefinitions: [
            { name: 'fixture', sourceArray: 'FIXTURE_MIGRATIONS' },
            { name: 'other', sourceArray: 'FIXTURE_MIGRATIONS' },
          ],
          repoRoot: setup.repoRoot,
        }),
      /source array is duplicated/u
    )
  } finally {
    rmSync(setup.repoRoot, { force: true, recursive: true })
  }
})

test('inventory refuses two different files with the same version in one phase', () => {
  const setup = fixture()
  try {
    writeFileSync(
      resolve(setup.repoRoot, 'scripts/maintenance/apply-launch-migrations.sh'),
      'FIXTURE_MIGRATIONS=(\n  20260804000000_fixture.sql\n  20260804000000_other.sql\n)\nreadonly -a FIXTURE_MIGRATIONS\n'
    )
    writeFileSync(resolve(setup.migrations, '20260804000000_other.sql'), 'SELECT 2;\n')
    assert.throws(
      () =>
        buildLaunchMigrationInventory({
          phaseDefinitions: [{ name: 'fixture', sourceArray: 'FIXTURE_MIGRATIONS' }],
          repoRoot: setup.repoRoot,
        }),
      /duplicate migration version/u
    )
  } finally {
    rmSync(setup.repoRoot, { force: true, recursive: true })
  }
})

test('final attestation rejects a previously read migration replaced with identical bytes', () => {
  const setup = fixture()
  const migration = resolve(setup.migrations, '20260804000000_fixture.sql')
  try {
    const original = readFileSync(migration)
    assert.throws(
      () =>
        buildLaunchMigrationInventory({
          beforeFinalAttestation() {
            const replacement = `${migration}.replacement`
            writeFileSync(replacement, original)
            renameSync(replacement, migration)
          },
          phaseDefinitions: [{ name: 'fixture', sourceArray: 'FIXTURE_MIGRATIONS' }],
          repoRoot: setup.repoRoot,
        }),
      /changed after it was inventoried/u
    )
  } finally {
    rmSync(setup.repoRoot, { force: true, recursive: true })
  }
})

test('final attestation hook is test-only and strictly typed', () => {
  const setup = fixture()
  try {
    assert.throws(
      () =>
        buildLaunchMigrationInventory({
          beforeFinalAttestation: true,
          phaseDefinitions: [{ name: 'fixture', sourceArray: 'FIXTURE_MIGRATIONS' }],
          repoRoot: setup.repoRoot,
        }),
      /beforeFinalAttestation must be a function/u
    )
    assert.throws(
      () =>
        buildLaunchMigrationInventory({
          beforeFinalAttestation: async () => {},
          phaseDefinitions: [{ name: 'fixture', sourceArray: 'FIXTURE_MIGRATIONS' }],
          repoRoot: setup.repoRoot,
        }),
      /must complete synchronously/u
    )
  } finally {
    rmSync(setup.repoRoot, { force: true, recursive: true })
  }
})

test('CLI emits only deterministic inventory JSON and rejects arguments', () => {
  const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.contract, LAUNCH_MIGRATION_INVENTORY_CONTRACT)
  assert.equal(result.stdout.includes('postgres://'), false)
  // No credential values. The bare word is not checked: migration file names
  // such as 20261113151849_auth_user_has_password_rpc.sql legitimately contain it.
  assert.doesNotMatch(result.stdout, /password\s*[=:]|:[^/@\s"]+@/iu)
  assert.doesNotMatch(result.stdout, /PGPASSWORD|service_role_key|eyJhbGci/u)

  const invalid = spawnSync(process.execPath, [SCRIPT, '--live'], { encoding: 'utf8' })
  assert.equal(invalid.status, 2)
  assert.match(invalid.stderr, /Usage:/u)
})
