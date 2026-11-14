import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  SOURCE_CATALOG_CONTRACT,
  SOURCE_CATALOG_KEYS,
} from './baseline-source-catalog-contract.mjs'
import { buildLaunchMigrationInventory } from './launch-migration-inventory.mjs'
import {
  SOURCE_LAUNCH_RECONCILIATION_CONTRACT,
  SOURCE_LAUNCH_RECONCILIATION_STATUS,
  reconcileSourceLedger,
  validateSourceCatalogForReconciliation,
} from './source-launch-ledger-reconciliation.mjs'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const SCRIPT = resolve(ROOT, 'scripts/qa/source-launch-ledger-reconciliation.mjs')

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])])
    )
  }
  return value
}

function emptyCatalog() {
  return Object.fromEntries(SOURCE_CATALOG_KEYS.map((key) => [key, []]))
}

function sourceCatalog(ledger) {
  return {
    capturedAt: '2026-08-05T02:00:00.000Z',
    catalog: emptyCatalog(),
    contract: SOURCE_CATALOG_CONTRACT,
    ledger: [...ledger].sort((left, right) =>
      JSON.stringify(canonicalize(left)).localeCompare(JSON.stringify(canonicalize(right)))
    ),
    postgresMajor: 17,
  }
}

function fixture() {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'arena-source-ledger-'))
  const runner = resolve(repoRoot, 'scripts/maintenance/apply-launch-migrations.sh')
  const migrationsRoot = resolve(repoRoot, 'supabase/migrations')
  mkdirSync(dirname(runner), { recursive: true })
  mkdirSync(migrationsRoot, { recursive: true })
  writeFileSync(runner, 'FIXTURE_MIGRATIONS=(\n  20260804000000_fixture.sql\n)\n')
  writeFileSync(resolve(migrationsRoot, '20260804000000_fixture.sql'), 'SELECT 1;\n')
  const inventory = buildLaunchMigrationInventory({
    phaseDefinitions: [{ name: 'fixture', sourceArray: 'FIXTURE_MIGRATIONS' }],
    repoRoot,
  })
  const migration = inventory.phases[0].migrations[0]
  return { inventory, migration, repoRoot }
}

function ledgerRow(migration, overrides = {}) {
  return {
    createdBy: 'codex',
    idempotencyKey: `codex:${migration.version}:${migration.sha256}`,
    name: migration.name,
    statementsSha256: migration.ledgerStatementsSha256,
    version: migration.version,
    ...overrides,
  }
}

test('classifies all five launch-runner ledger identity fields deterministically', () => {
  const setup = fixture()
  try {
    const input = {
      inventory: setup.inventory,
      phaseNames: ['fixture'],
      sourceCatalog: sourceCatalog([ledgerRow(setup.migration)]),
    }
    const first = reconcileSourceLedger(input)
    const second = reconcileSourceLedger(input)
    assert.deepEqual(first, second)
    assert.equal(first.contract, SOURCE_LAUNCH_RECONCILIATION_CONTRACT)
    assert.equal(first.status, SOURCE_LAUNCH_RECONCILIATION_STATUS)
    assert.equal(first.outcome, 'exact')
    assert.deepEqual(first.summary, {
      drift: 0,
      exact: 1,
      expected: 1,
      missing: 0,
      sourceLedgerModern: 1,
      unknown: 0,
    })
    assert.equal(first.results[0].classification, 'exact')
    assert.deepEqual(first.results[0].expected, {
      createdBy: 'codex',
      idempotencyKey: `codex:${setup.migration.version}:${setup.migration.sha256}`,
      name: setup.migration.name,
      statementsSha256: setup.migration.ledgerStatementsSha256,
    })
    assert.equal(Object.hasOwn(first.results[0].observed, 'statements'), false)
    assert.match(first.reconciliationSha256, /^[a-f0-9]{64}$/u)
  } finally {
    rmSync(setup.repoRoot, { force: true, recursive: true })
  }
})

test('keeps missing, drift, and out-of-scope unknown rows distinct', async (t) => {
  await t.test('missing with unrelated source row', () => {
    const setup = fixture()
    try {
      const report = reconcileSourceLedger({
        inventory: setup.inventory,
        phaseNames: ['fixture'],
        sourceCatalog: sourceCatalog([
          {
            createdBy: null,
            idempotencyKey: null,
            name: 'unrelated',
            statementsSha256: 'a'.repeat(64),
            version: '20260803000000',
          },
        ]),
      })
      assert.equal(report.outcome, 'incomplete')
      assert.equal(report.results[0].classification, 'missing')
      assert.deepEqual(report.results[0].mismatches, ['version'])
      assert.equal(report.summary.unknown, 1)
    } finally {
      rmSync(setup.repoRoot, { force: true, recursive: true })
    }
  })

  await t.test('same version with name, body, creator, and idempotency drift', () => {
    const setup = fixture()
    try {
      const report = reconcileSourceLedger({
        inventory: setup.inventory,
        phaseNames: ['fixture'],
        sourceCatalog: sourceCatalog([
          ledgerRow(setup.migration, {
            createdBy: 'manual',
            idempotencyKey: 'manual:fixture',
            name: 'renamed_fixture',
            statementsSha256: 'b'.repeat(64),
          }),
        ]),
      })
      assert.equal(report.results[0].classification, 'drift')
      assert.deepEqual(report.results[0].mismatches, [
        'name',
        'statementsSha256',
        'createdBy',
        'idempotencyKey',
      ])
      assert.equal(report.results[0].observed.name, 'renamed_fixture')
    } finally {
      rmSync(setup.repoRoot, { force: true, recursive: true })
    }
  })

  await t.test('related identity under another version is drift, not missing', () => {
    const setup = fixture()
    try {
      const report = reconcileSourceLedger({
        inventory: setup.inventory,
        phaseNames: ['fixture'],
        sourceCatalog: sourceCatalog([
          ledgerRow(setup.migration, {
            createdBy: 'manual',
            idempotencyKey: 'manual:20260803000000',
            version: '20260803000000',
          }),
        ]),
      })
      assert.equal(report.results[0].classification, 'drift')
      assert.deepEqual(report.results[0].mismatches, ['version', 'createdBy', 'idempotencyKey'])
      assert.equal(report.results[0].relatedLedger.length, 1)
      assert.equal(report.summary.unknown, 1)
    } finally {
      rmSync(setup.repoRoot, { force: true, recursive: true })
    }
  })
})

test('never calls a three-field match exact when creator or idempotency key drifts', async (t) => {
  for (const [field, value] of [
    ['createdBy', 'manual'],
    ['idempotencyKey', 'codex:20260804000000:wrong-file-digest'],
  ]) {
    await t.test(field, () => {
      const setup = fixture()
      try {
        const report = reconcileSourceLedger({
          inventory: setup.inventory,
          phaseNames: ['fixture'],
          sourceCatalog: sourceCatalog([ledgerRow(setup.migration, { [field]: value })]),
        })
        assert.equal(report.outcome, 'incomplete')
        assert.equal(report.results[0].classification, 'drift')
        assert.deepEqual(report.results[0].mismatches, [field])
      } finally {
        rmSync(setup.repoRoot, { force: true, recursive: true })
      }
    })
  }
})

test('fails closed on invalid source and inventory contracts', async (t) => {
  await t.test('no modern ledger boundary', () => {
    assert.throws(
      () => validateSourceCatalogForReconciliation(sourceCatalog([])),
      /modern 14-digit baseline boundary/u
    )
  })

  await t.test('duplicate modern source version', () => {
    const document = sourceCatalog([
      {
        createdBy: null,
        idempotencyKey: null,
        name: 'a',
        statementsSha256: 'a'.repeat(64),
        version: '20260804000000',
      },
      {
        createdBy: null,
        idempotencyKey: null,
        name: 'b',
        statementsSha256: 'b'.repeat(64),
        version: '20260804000000',
      },
    ])
    assert.throws(
      () => validateSourceCatalogForReconciliation(document),
      /duplicates modern source ledger version/u
    )
  })

  await t.test('missing creator field', () => {
    assert.throws(
      () =>
        validateSourceCatalogForReconciliation(
          sourceCatalog([
            {
              idempotencyKey: null,
              name: 'missing_creator',
              statementsSha256: 'a'.repeat(64),
              version: '20260804000000',
            },
          ])
        ),
      /must contain exactly/u
    )
  })

  for (const [label, credential] of [
    ['PostgreSQL URL', 'postgres://user:secret@db.example.invalid/database'],
    ['Redis URL', 'rediss://default:secret@cache.example.invalid:6379'],
    ['GitHub token', `github_pat_${'a'.repeat(32)}`],
    ['Stripe key', `sk_live_${'b'.repeat(24)}`],
    ['quoted assignment', `api_token='${'c'.repeat(24)}'`],
  ]) {
    await t.test(`credential-like captured value: ${label}`, () => {
      const setup = fixture()
      try {
        assert.throws(
          () =>
            reconcileSourceLedger({
              inventory: setup.inventory,
              phaseNames: ['fixture'],
              sourceCatalog: sourceCatalog([
                ledgerRow(setup.migration, {
                  name: credential,
                }),
              ]),
            }),
          /credential-like data/u
        )
      } finally {
        rmSync(setup.repoRoot, { force: true, recursive: true })
      }
    })
  }

  await t.test('tampered inventory digest', () => {
    const setup = fixture()
    try {
      assert.throws(
        () =>
          reconcileSourceLedger({
            inventory: { ...setup.inventory, inventorySha256: 'f'.repeat(64) },
            phaseNames: ['fixture'],
            sourceCatalog: sourceCatalog([ledgerRow(setup.migration)]),
          }),
        /inventory digest does not match/u
      )
    } finally {
      rmSync(setup.repoRoot, { force: true, recursive: true })
    }
  })
})

test('CLI reads one canonical owner-only artifact and emits no credential material', () => {
  const tempRoot = realpathSync(mkdtempSync(resolve(tmpdir(), 'arena-source-ledger-cli-')))
  const sourcePath = resolve(tempRoot, 'source-catalog.json')
  const symlinkPath = resolve(tempRoot, 'source-catalog-link.json')
  try {
    const inventory = buildLaunchMigrationInventory({ repoRoot: ROOT })
    const predeploy = inventory.phases.find((phase) => phase.name === 'predeploy')
    const document = sourceCatalog(predeploy.migrations.map((migration) => ledgerRow(migration)))
    writeFileSync(sourcePath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
    const exact = spawnSync(
      process.execPath,
      [SCRIPT, '--source-catalog', sourcePath, '--phase', 'predeploy'],
      { encoding: 'utf8' }
    )
    assert.equal(exact.status, 0, exact.stderr)
    const report = JSON.parse(exact.stdout)
    assert.equal(report.outcome, 'exact')
    assert.equal(report.summary.exact, 156)
    assert.equal(exact.stdout.includes('postgres://'), false)
    // No credential values; migration file names (…_auth_user_has_password_rpc.sql)
    // legitimately contain the bare word.
    assert.doesNotMatch(exact.stdout, /password\s*[=:]|:[^/@\s"]+@/iu)
    assert.equal(exact.stdout.includes('"statements"'), false)

    symlinkSync(sourcePath, symlinkPath)
    const symlinked = spawnSync(process.execPath, [SCRIPT, '--source-catalog', symlinkPath], {
      encoding: 'utf8',
    })
    assert.equal(symlinked.status, 2)
    assert.match(symlinked.stderr, /without symlink components/u)

    chmodSync(sourcePath, 0o644)
    const exposed = spawnSync(process.execPath, [SCRIPT, '--source-catalog', sourcePath], {
      encoding: 'utf8',
    })
    assert.equal(exposed.status, 2)
    assert.match(exposed.stderr, /owner-only/u)

    chmodSync(sourcePath, 0o600)
    chmodSync(tempRoot, 0o755)
    const exposedParent = spawnSync(process.execPath, [SCRIPT, '--source-catalog', sourcePath], {
      encoding: 'utf8',
    })
    assert.equal(exposedParent.status, 2)
    assert.match(exposedParent.stderr, /parent must be owner-only/u)
  } finally {
    rmSync(tempRoot, { force: true, recursive: true })
  }
})
