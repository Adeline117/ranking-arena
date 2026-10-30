import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BASELINE_REPLAY_COMPARISON_CONTRACT,
  BASELINE_REPLAY_TARGET_WITNESS_CONTRACT,
  BASELINE_REPLAY_WITNESS_STATUS,
  canonicalReplayWitnessSha256,
  compareBaselineReplayWitness,
} from './baseline-replay-witness-comparator.mjs'
import {
  SOURCE_CATALOG_CONTRACT,
  SOURCE_CATALOG_KEYS,
} from './baseline-source-catalog-contract.mjs'

const BASELINE_THROUGH = '20260804000000'
const FORWARD_VERSION = '20260804000001'

function emptyCatalog() {
  return Object.fromEntries(SOURCE_CATALOG_KEYS.map((key) => [key, []]))
}

function table(name) {
  return {
    forceRowSecurity: false,
    kind: 'r',
    name,
    owner: 'postgres',
    partitionBound: null,
    persistence: 'p',
    rowSecurity: false,
    schema: 'arena',
  }
}

function publication(name) {
  return {
    allTables: false,
    columns: [],
    deletes: true,
    inserts: true,
    membershipKind: 'relation',
    name,
    relation: 'source_table',
    rowFilter: null,
    schema: 'arena',
    truncates: true,
    updates: true,
    viaPartitionRoot: false,
  }
}

function column(name) {
  return {
    acl: ['app_reader=r/postgres'],
    defaultExpression: null,
    generated: '',
    identity: '',
    name,
    notNull: false,
    ordinal: 1,
    relation: 'source_table',
    schema: 'arena',
    type: 'bigint',
  }
}

function securityDefinerFunction(name) {
  return {
    configuration: ['search_path=pg_catalog, arena'],
    definition: `CREATE OR REPLACE FUNCTION arena.${name}() RETURNS integer LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'`,
    identityArguments: '',
    kind: 'f',
    language: 'sql',
    leakproof: false,
    name,
    owner: 'postgres',
    result: 'integer',
    schema: 'arena',
    securityDefiner: true,
    volatility: 'v',
  }
}

function view(name, kind = 'v') {
  return {
    definition: ' SELECT source_table.id\n   FROM arena.source_table;',
    kind,
    name,
    owner: 'postgres',
    reloptions:
      kind === 'v'
        ? ['check_option=cascaded', 'security_barrier=true', 'security_invoker=true']
        : ['fillfactor=80'],
    schema: 'arena',
  }
}

function sortRows(rows) {
  rows.sort((left, right) => {
    const leftJson = JSON.stringify(left)
    const rightJson = JSON.stringify(right)
    if (leftJson < rightJson) return -1
    if (leftJson > rightJson) return 1
    return 0
  })
}

function fixture({ withForward = true } = {}) {
  const sourceCatalogRows = emptyCatalog()
  sourceCatalogRows.tables = [table('source_table')]
  sourceCatalogRows.publications = [publication('source_publication')]
  const ledger = [
    {
      createdBy: null,
      idempotencyKey: null,
      name: 'source_boundary',
      statementsSha256: 'a'.repeat(64),
      version: BASELINE_THROUGH,
    },
  ]
  const sourceCatalog = {
    capturedAt: '2026-08-04T21:30:00.000Z',
    catalog: sourceCatalogRows,
    contract: SOURCE_CATALOG_CONTRACT,
    ledger,
    postgresMajor: 17,
  }
  const migrations = withForward
    ? [
        {
          path: `supabase/migrations/${FORWARD_VERSION}_fixture_forward.sql`,
          sha256: 'b'.repeat(64),
          version: FORWARD_VERSION,
        },
      ]
    : []
  const forwardManifest = {
    baselineThrough: BASELINE_THROUGH,
    contract: 'arena.canonical-baseline-forward-migrations@1',
    migrationSetSha256: canonicalReplayWitnessSha256(migrations),
    migrations,
    repositoryMigrationSetSha256: 'c'.repeat(64),
  }
  const baselineCatalog = structuredClone(sourceCatalogRows)
  baselineCatalog.publications = []
  const finalCatalog = structuredClone(baselineCatalog)
  if (withForward) {
    finalCatalog.tables.push(table('forward_table'))
    sortRows(finalCatalog.tables)
  }
  const targetWitness = {
    baselineCatalog,
    contract: BASELINE_REPLAY_TARGET_WITNESS_CONTRACT,
    finalCatalog,
    forwardExecutions: structuredClone(migrations),
    postgresMajor: 17,
    source: {
      baselineThrough: BASELINE_THROUGH,
      catalogSha256: canonicalReplayWitnessSha256(sourceCatalogRows),
      ledgerSha256: canonicalReplayWitnessSha256(ledger),
    },
    status: BASELINE_REPLAY_WITNESS_STATUS,
  }
  return { forwardManifest, sourceCatalog, targetWitness }
}

function compare(value) {
  return compareBaselineReplayWitness(value)
}

function addSourceBoundaryRow(value, key, row) {
  value.sourceCatalog.catalog[key] = [structuredClone(row)]
  value.targetWitness.baselineCatalog[key] = [structuredClone(row)]
  value.targetWitness.finalCatalog[key] = [structuredClone(row)]
  value.targetWitness.source.catalogSha256 = canonicalReplayWitnessSha256(
    value.sourceCatalog.catalog
  )
}

test('attests the source boundary and exact forward execution without claiming promotion equivalence', () => {
  const value = fixture()
  const result = compare(value)

  assert.equal(result.contract, BASELINE_REPLAY_COMPARISON_CONTRACT)
  assert.equal(result.status, BASELINE_REPLAY_WITNESS_STATUS)
  assert.deepEqual(result.sourceBoundary, {
    comparableCatalogKeyCount: SOURCE_CATALOG_KEYS.length - 1,
    comparableCatalogMatched: true,
    publicationEvidenceCount: 1,
    publicationsReplayed: false,
    sourceCatalogSha256: value.targetWitness.source.catalogSha256,
    sourceLedgerDigestAnchored: true,
    sourceLedgerSha256: value.targetWitness.source.ledgerSha256,
  })
  assert.deepEqual(result.forward.changedCatalogKeys, ['tables'])
  assert.equal(result.forward.executionCount, 1)
  assert.equal(result.forward.executionLedgerMatched, true)
  assert.equal(result.forward.observedCatalogDelta.tables.addedCount, 1)
  assert.equal(result.forward.observedCatalogDelta.tables.removedCount, 0)
  assert.equal(result.finalCatalogApproved, false)
  assert.equal(result.managedSupabaseEquivalent, false)
  assert.equal(result.productionEquivalent, false)
  assert.equal(result.promotionEvidence, false)
})

test('rejects any source-boundary catalog mismatch outside the declared publication omission', () => {
  const value = fixture()
  value.targetWitness.baselineCatalog.tables = []
  assert.throws(() => compare(value), /baseline catalog tables does not match/)
})

test('rejects drift in column ACL, SECURITY DEFINER owner, and view security metadata', async (t) => {
  const scenarios = [
    {
      key: 'columns',
      mutate: (row) => {
        row.acl = []
      },
      name: 'column default-ACL versus explicit empty ACL',
      row: { ...column('default_acl_value'), acl: null },
    },
    {
      key: 'columns',
      mutate: (row) => {
        row.acl = ['app_reader=r/postgres', 'service_role=w/postgres']
      },
      name: 'column-level GRANT',
      row: column('secret_value'),
    },
    {
      key: 'functions',
      mutate: (row) => {
        row.owner = 'app_runtime'
      },
      name: 'SECURITY DEFINER owner',
      row: securityDefinerFunction('trusted_write'),
    },
    {
      key: 'views',
      mutate: (row) => {
        row.owner = 'app_runtime'
      },
      name: 'view owner',
      row: view('secured_rows'),
    },
    {
      key: 'views',
      mutate: (row) => {
        row.reloptions = [
          'check_option=cascaded',
          'security_barrier=false',
          'security_invoker=true',
        ]
      },
      name: 'view reloptions',
      row: view('secured_rows'),
    },
    {
      key: 'views',
      mutate: (row) => {
        row.owner = 'app_runtime'
      },
      name: 'materialized-view owner',
      row: view('materialized_rows', 'm'),
    },
  ]

  for (const scenario of scenarios) {
    await t.test(scenario.name, () => {
      const value = fixture()
      addSourceBoundaryRow(value, scenario.key, scenario.row)
      scenario.mutate(value.targetWitness.baselineCatalog[scenario.key][0])
      assert.throws(
        () => compare(value),
        new RegExp(`baseline catalog ${scenario.key} does not match`, 'u')
      )
    })
  }
})

test('rejects publications materialized before the forward epoch', () => {
  const value = fixture()
  value.targetWitness.baselineCatalog.publications = [publication('undeclared_publication')]
  assert.throws(() => compare(value), /baseline catalog contains undeclared publications/)
})

test('rejects source catalogue and ledger anchors that do not match the captured witness', async (t) => {
  for (const [field, message] of [
    ['catalogSha256', /catalogSha256 does not match/],
    ['ledgerSha256', /ledgerSha256 does not match/],
  ]) {
    await t.test(field, () => {
      const value = fixture()
      value.targetWitness.source[field] = 'f'.repeat(64)
      assert.throws(() => compare(value), message)
    })
  }
})

test('requires creator and idempotency fields even when both values are unknown', () => {
  const value = fixture()
  delete value.sourceCatalog.ledger[0].createdBy
  assert.throws(() => compare(value), /source-catalog\.json ledger\[0\] must contain exactly/u)
})

test('rejects missing, reordered, changed, and extra forward execution rows', async (t) => {
  for (const scenario of ['missing', 'reordered', 'changed', 'extra']) {
    await t.test(scenario, () => {
      const value = fixture()
      const expected = value.targetWitness.forwardExecutions[0]
      const second = {
        path: 'supabase/migrations/20260804000002_fixture_second.sql',
        sha256: 'd'.repeat(64),
        version: '20260804000002',
      }
      value.forwardManifest.migrations.push(second)
      value.forwardManifest.migrationSetSha256 = canonicalReplayWitnessSha256(
        value.forwardManifest.migrations
      )
      value.targetWitness.forwardExecutions.push(second)
      if (scenario === 'missing') value.targetWitness.forwardExecutions.pop()
      if (scenario === 'reordered') value.targetWitness.forwardExecutions.reverse()
      if (scenario === 'changed')
        value.targetWitness.forwardExecutions[0] = { ...expected, sha256: 'e'.repeat(64) }
      if (scenario === 'extra') {
        value.targetWitness.forwardExecutions.push({
          path: 'supabase/migrations/20260804000003_fixture_extra.sql',
          sha256: 'e'.repeat(64),
          version: '20260804000003',
        })
      }
      assert.throws(() => compare(value), /execution ledger does not exactly match/)
    })
  }
})

test('rejects final catalogue drift when there is no declared forward migration', () => {
  const value = fixture({ withForward: false })
  value.targetWitness.finalCatalog.tables.push(table('undeclared_table'))
  assert.throws(() => compare(value), /final catalog changed without a declared forward migration/)
})

test('rejects malformed, noncanonical, and duplicate target catalogue rows', async (t) => {
  for (const scenario of ['malformed', 'noncanonical', 'duplicate']) {
    await t.test(scenario, () => {
      const value = fixture()
      if (scenario === 'malformed') value.targetWitness.finalCatalog.tables[0].unexpected = true
      if (scenario === 'noncanonical') {
        value.targetWitness.finalCatalog.tables = [table('z_table'), table('a_table')]
      }
      if (scenario === 'duplicate') {
        value.targetWitness.finalCatalog.tables = [table('duplicate'), table('duplicate')]
      }
      assert.throws(
        () => compare(value),
        /must contain exactly|canonically sorted and contain no duplicates/
      )
    })
  }
})

test('rejects a target witness that upgrades its non-promotion status', () => {
  const value = fixture()
  value.targetWitness.status = 'promotion-ready'
  assert.throws(
    () => compare(value),
    /status must remain dependency-witness\/not-promotion-evidence/
  )
})
