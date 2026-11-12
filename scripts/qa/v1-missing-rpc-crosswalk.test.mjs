import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  buildMissingRpcCrosswalk,
  MISSING_RPC_DEFINITIONS,
  REQUIRED_RANKING_MIGRATION_ORDER,
  V1_MISSING_RPC_CROSSWALK_CONTRACT,
  V1_MISSING_RPC_CROSSWALK_STATUS,
} from './v1-missing-rpc-crosswalk.mjs'
import {
  buildLaunchMigrationInventory,
  canonicalJsonSha256,
} from './launch-migration-inventory.mjs'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const SCRIPT = resolve(ROOT, 'scripts/qa/v1-missing-rpc-crosswalk.mjs')

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex')
}

function copyCrosswalkEvidenceRepo() {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'arena-rpc-crosswalk-'))
  const paths = new Set(['lib/supabase/database.types.ts'])
  for (const definition of MISSING_RPC_DEFINITIONS) {
    paths.add(`supabase/migrations/${definition.definingMigration}`)
    paths.add(`supabase/migrations/${definition.aclEvidence.migration}`)
    if (definition.aclEvidence.test) paths.add(definition.aclEvidence.test)
    for (const evidencePath of [...definition.consumers, ...definition.tests]) {
      paths.add(evidencePath)
    }
  }
  for (const relativePath of paths) {
    const destination = resolve(repoRoot, relativePath)
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(resolve(ROOT, relativePath), destination)
  }
  return repoRoot
}

function reattestChangedMigration(inventory, migrationFile, contents) {
  const copy = structuredClone(inventory)
  const migration = copy.phases
    .flatMap((phase) => phase.migrations)
    .find((entry) => entry.file === migrationFile)
  assert.ok(migration)
  migration.sha256 = sha256(contents)
  migration.ledgerStatementsSha256 = sha256(
    JSON.stringify({ kind: 'sql-statements', value: [contents.toString('utf8')] })
  )
  const phase = copy.phases.find((entry) =>
    entry.migrations.some((candidate) => candidate.file === migrationFile)
  )
  phase.migrationSetSha256 = canonicalJsonSha256(phase.migrations)
  const { inventorySha256: _oldDigest, ...attested } = copy
  copy.inventorySha256 = canonicalJsonSha256(attested)
  return copy
}

function assertRetirementAclMutationRejected(mutate, expectedError) {
  const inventory = buildLaunchMigrationInventory({ repoRoot: ROOT })
  const migrationFile = '20261111133300_retire_legacy_token_rankings_cron_api.sql'
  const repoRoot = copyCrosswalkEvidenceRepo()
  try {
    const migrationPath = resolve(repoRoot, `supabase/migrations/${migrationFile}`)
    const original = readFileSync(migrationPath, 'utf8')
    const changedText = mutate(original)
    assert.notEqual(changedText, original)
    const changed = Buffer.from(changedText)
    writeFileSync(migrationPath, changed)
    assert.throws(
      () =>
        buildMissingRpcCrosswalk({
          inventory: reattestChangedMigration(inventory, migrationFile, changed),
          repoRoot,
        }),
      expectedError
    )
  } finally {
    rmSync(repoRoot, { force: true, recursive: true })
  }
}

function assertRetirementPg17MutationRejected(mutate, expectedError) {
  const inventory = buildLaunchMigrationInventory({ repoRoot: ROOT })
  const repoRoot = copyCrosswalkEvidenceRepo()
  try {
    const proofPath = resolve(
      repoRoot,
      'supabase/migrations/__tests__/token-ranking-generation-barrier.pg17.sh'
    )
    const original = readFileSync(proofPath, 'utf8')
    const changed = mutate(original)
    assert.notEqual(changed, original)
    writeFileSync(proofPath, changed)
    assert.throws(() => buildMissingRpcCrosswalk({ inventory, repoRoot }), expectedError)
  } finally {
    rmSync(repoRoot, { force: true, recursive: true })
  }
}

test('builds a deterministic five-RPC repository and historical-gap crosswalk', () => {
  const first = buildMissingRpcCrosswalk({ repoRoot: ROOT })
  const second = buildMissingRpcCrosswalk({ repoRoot: ROOT })
  assert.deepEqual(first, second)
  assert.equal(first.contract, V1_MISSING_RPC_CROSSWALK_CONTRACT)
  assert.equal(first.status, V1_MISSING_RPC_CROSSWALK_STATUS)
  assert.deepEqual(first.requiredMigrationOrder, REQUIRED_RANKING_MIGRATION_ORDER)
  assert.deepEqual(
    first.rpcs.map((rpc) => rpc.name),
    [
      'get_popular_tokens_v2',
      'get_token_ranking_publication_head',
      'get_token_trader_rankings_v2',
      'refresh_public_rank_count_cache_for_seasons',
      'rerank_public_eligible_leaderboard',
    ]
  )
  assert.match(first.crosswalkSha256, /^[a-f0-9]{64}$/u)
  const aclByName = new Map(first.rpcs.map((rpc) => [rpc.name, rpc.expectedAcl]))
  assert.equal(aclByName.get('rerank_public_eligible_leaderboard'), 'service_role-execute-only')
  assert.equal(
    aclByName.get('refresh_public_rank_count_cache_for_seasons'),
    'service_role-execute-only'
  )
  assert.equal(aclByName.get('get_token_ranking_publication_head'), 'service_role-execute-only')
  assert.equal(aclByName.get('get_token_trader_rankings_v2'), 'owner-only/no-non-owner-execute')
  assert.equal(aclByName.get('get_popular_tokens_v2'), 'owner-only/no-non-owner-execute')
  for (const rpc of first.rpcs) {
    assert.match(rpc.aclEvidence.migration.sha256, /^[a-f0-9]{64}$/u)
    assert.match(rpc.definingMigration.sha256, /^[a-f0-9]{64}$/u)
    assert.match(rpc.definingMigration.ledgerStatementsSha256, /^[a-f0-9]{64}$/u)
    assert.ok(rpc.repositoryEvidence.length >= 3)
  }
})

test('fails closed on incomplete, duplicate, or ungrounded definitions', () => {
  assert.throws(
    () =>
      buildMissingRpcCrosswalk({
        definitions: MISSING_RPC_DEFINITIONS.slice(0, 4),
        repoRoot: ROOT,
      }),
    /exactly five definitions/u
  )

  const duplicated = MISSING_RPC_DEFINITIONS.map((definition) => ({ ...definition }))
  duplicated[4] = { ...duplicated[4], name: duplicated[0].name }
  assert.throws(
    () => buildMissingRpcCrosswalk({ definitions: duplicated, repoRoot: ROOT }),
    /identity is duplicated/u
  )

  const missingMigration = MISSING_RPC_DEFINITIONS.map((definition) => ({ ...definition }))
  missingMigration[0] = {
    ...missingMigration[0],
    aclEvidence: {
      ...missingMigration[0].aclEvidence,
      migration: '20260804999999_missing.sql',
    },
    definingMigration: '20260804999999_missing.sql',
  }
  assert.throws(
    () => buildMissingRpcCrosswalk({ definitions: missingMigration, repoRoot: ROOT }),
    /defining migration.*is not in predeploy/u
  )

  const ungroundedConsumer = MISSING_RPC_DEFINITIONS.map((definition) => ({ ...definition }))
  ungroundedConsumer[0] = { ...ungroundedConsumer[0], consumers: ['package.json'] }
  assert.throws(
    () => buildMissingRpcCrosswalk({ definitions: ungroundedConsumer, repoRoot: ROOT }),
    /does not reference/u
  )
})

test('rejects mixed-generation inventory bytes and a mismatched CREATE overload', () => {
  const inventory = buildLaunchMigrationInventory({ repoRoot: ROOT })
  const migrationFile = MISSING_RPC_DEFINITIONS[0].definingMigration
  const relativePath = `supabase/migrations/${migrationFile}`

  for (const scenario of ['stale inventory bytes', 'mismatched create signature']) {
    const repoRoot = copyCrosswalkEvidenceRepo()
    try {
      const migrationPath = resolve(repoRoot, relativePath)
      const original = readFileSync(migrationPath)
      const changed =
        scenario === 'stale inventory bytes'
          ? Buffer.concat([original, Buffer.from('\n-- concurrent drift\n')])
          : Buffer.from(
              original.toString('utf8').replace('p_season_id text', 'p_season_id integer')
            )
      writeFileSync(migrationPath, changed)
      const suppliedInventory =
        scenario === 'stale inventory bytes'
          ? inventory
          : reattestChangedMigration(inventory, migrationFile, changed)
      assert.throws(
        () => buildMissingRpcCrosswalk({ inventory: suppliedInventory, repoRoot }),
        scenario === 'stale inventory bytes'
          ? /inventory changed or is inconsistent/u
          : /does not contain exact RPC signature/u
      )
    } finally {
      rmSync(repoRoot, { force: true, recursive: true })
    }
  }
})

test('ignores RPC signatures forged in SQL comments and string literals', () => {
  const inventory = buildLaunchMigrationInventory({ repoRoot: ROOT })
  const definition = MISSING_RPC_DEFINITIONS[0]
  const migrationFile = definition.definingMigration
  const repoRoot = copyCrosswalkEvidenceRepo()
  try {
    const migrationPath = resolve(repoRoot, `supabase/migrations/${migrationFile}`)
    const original = readFileSync(migrationPath, 'utf8')
    const realHeader =
      'CREATE OR REPLACE FUNCTION public.rerank_public_eligible_leaderboard(\n' +
      '  p_season_id text\n' +
      ')'
    const inlineHeader = realHeader.replace(/\s+/gu, ' ')
    assert.ok(original.includes(realHeader))
    const changed = Buffer.from(
      original.replace(realHeader, realHeader.replace('p_season_id text', 'p_season_id integer')) +
        `\n-- ${inlineHeader}\n/* ${realHeader} */\nSELECT '${inlineHeader}';\n`
    )
    writeFileSync(migrationPath, changed)
    assert.throws(
      () =>
        buildMissingRpcCrosswalk({
          inventory: reattestChangedMigration(inventory, migrationFile, changed),
          repoRoot,
        }),
      /does not contain exact RPC signature/u
    )
  } finally {
    rmSync(repoRoot, { force: true, recursive: true })
  }
})

test('rejects generated-type and runtime-consumer references forged outside executable structure', () => {
  const inventory = buildLaunchMigrationInventory({ repoRoot: ROOT })
  for (const scenario of ['generated type', 'runtime consumer']) {
    const repoRoot = copyCrosswalkEvidenceRepo()
    try {
      if (scenario === 'generated type') {
        const typesPath = resolve(repoRoot, 'lib/supabase/database.types.ts')
        const original = readFileSync(typesPath, 'utf8')
        const expected = 'rerank_public_eligible_leaderboard: {'
        assert.ok(original.includes(expected))
        writeFileSync(
          typesPath,
          original.replace(expected, 'removed_rerank_rpc: {') +
            `\n// ${expected}\ntype ForgedRpcReference = '${expected}'\n`
        )
      } else {
        const consumerPath = resolve(repoRoot, 'app/api/cron/compute-leaderboard/rerank-cleanup.ts')
        const original = readFileSync(consumerPath, 'utf8')
        const expected = ".rpc('rerank_public_eligible_leaderboard'"
        assert.ok(original.includes(expected))
        writeFileSync(
          consumerPath,
          original.replace(expected, ".rpc('removed_rerank_rpc'") +
            `\n// ${expected}\nconst forgedRpcReference = ${JSON.stringify(expected)}\n`
        )
      }
      assert.throws(
        () => buildMissingRpcCrosswalk({ inventory, repoRoot }),
        scenario === 'generated type'
          ? /generated database types do not contain RPC/u
          : /crosswalk evidence file does not reference/u
      )
    } finally {
      rmSync(repoRoot, { force: true, recursive: true })
    }
  }
})

test('rejects TypeScript test references forged by inert literals, regexes, and vacuous assertions', () => {
  const inventory = buildLaunchMigrationInventory({ repoRoot: ROOT })
  const definition = MISSING_RPC_DEFINITIONS[0]
  const testPath = definition.tests.find((candidate) => candidate.endsWith('.test.ts'))
  assert.ok(testPath)
  const repoRoot = copyCrosswalkEvidenceRepo()
  try {
    const evidencePath = resolve(repoRoot, testPath)
    const original = readFileSync(evidencePath, 'utf8')
    assert.ok(original.includes(definition.name))
    const removedName = 'removed_rerank_rpc'
    const changed =
      original.replaceAll(definition.name, removedName) +
      `\n` +
      `describe('inert RPC decoys', () => {\n` +
      `  it('does not bind text to migration evidence', () => {\n` +
      `    const inertString = ${JSON.stringify(definition.name)}\n` +
      `    const inertRegex = /${definition.name}/\n` +
      `    void inertString\n` +
      `    void inertRegex\n` +
      `    expect(true).toBe(true)\n` +
      `    expect(true).not.toMatch(/${definition.name}/)\n` +
      `    for (const name of [${JSON.stringify(definition.name)}]) {\n` +
      `      expect(name).toBe(name)\n` +
      `      expect(migration && name).toBe(name)\n` +
      `    }\n` +
      `  })\n` +
      `})\n`
    writeFileSync(evidencePath, changed)
    assert.throws(
      () => buildMissingRpcCrosswalk({ inventory, repoRoot }),
      /crosswalk evidence file does not reference rerank_public_eligible_leaderboard/u
    )
  } finally {
    rmSync(repoRoot, { force: true, recursive: true })
  }
})

test('rejects retirement PG17 ACL evidence forged only in a shell comment', () => {
  const inventory = buildLaunchMigrationInventory({ repoRoot: ROOT })
  const repoRoot = copyCrosswalkEvidenceRepo()
  try {
    const proofPath = resolve(
      repoRoot,
      'supabase/migrations/__tests__/token-ranking-generation-barrier.pg17.sh'
    )
    const original = readFileSync(proofPath, 'utf8')
    const expected = "'public.get_token_ranking_publication_head()',"
    assert.ok(original.includes(expected))
    const changed = original.replaceAll(expected, "'public.removed_head()',") + `\n# ${expected}\n`
    writeFileSync(proofPath, changed)
    assert.throws(
      () => buildMissingRpcCrosswalk({ inventory, repoRoot }),
      /retirement PG17 ACL evidence is incomplete/u
    )
  } finally {
    rmSync(repoRoot, { force: true, recursive: true })
  }
})

test('rejects retirement ACL evidence forged by bare assignments and echo', () => {
  const signature = 'public.get_token_ranking_publication_head()'
  const expected = 'true|false|false|false|false|false|false'
  assertRetirementPg17MutationRejected((source) => {
    const start = source.indexOf('RUNTIME_ACL="$(psql_db -Atqc "')
    const end = source.indexOf('\n\nRUNTIME_MATRIX=', start)
    assert.ok(start >= 0 && end > start)
    const section = source
      .slice(start, end)
      .replace(`'${signature}',`, "'public.removed_head()',")
      .replace(`"${expected}"`, '"removed-runtime-acl-result"')
    assert.notEqual(section, source.slice(start, end))
    return (
      source.slice(0, start) +
      section +
      source.slice(end) +
      `\nHEAD_SIGNATURE_DECOY="'${signature}',"\n` +
      `HEAD_EXPECTED_DECOY='"${expected}"'\n` +
      `echo "$HEAD_SIGNATURE_DECOY" "$HEAD_EXPECTED_DECOY" >/dev/null\n`
    )
  }, /retirement PG17 ACL evidence is incomplete: get_token_ranking_publication_head/u)
})

test('rejects retirement ACL evidence forged inside quoted text and a heredoc body', () => {
  const signature = 'public.get_token_ranking_publication_head()'
  const expected = 'true|false|false|false|false|false|false'
  for (const decoyKind of ['quoted text', 'heredoc']) {
    assertRetirementPg17MutationRejected((source) => {
      const start = source.indexOf('RUNTIME_ACL="$(psql_db -Atqc "')
      const end = source.indexOf('\n\nRUNTIME_MATRIX=', start)
      assert.ok(start >= 0 && end > start)
      const section = source
        .slice(start, end)
        .replace(`'${signature}',`, "'public.removed_head()',")
        .replace(`"${expected}"`, '"removed-runtime-acl-result"')
      const forgedCommands =
        `RUNTIME_ACL="$(psql_db -Atqc "\n` +
        `  SELECT pg_catalog.has_function_privilege(\n` +
        `    'service_role', '${signature}', 'EXECUTE'\n` +
        `  ) || '|';\n` +
        `")"\n` +
        `assert_equal "forged ACL" "${expected}" "$RUNTIME_ACL"\n`
      const decoy =
        decoyKind === 'heredoc'
          ? `\ncat <<'INERT_ACL_EVIDENCE' >/dev/null\n${forgedCommands}INERT_ACL_EVIDENCE\n`
          : `\nINERT_ACL_EVIDENCE='\n${forgedCommands}'\n`
      return source.slice(0, start) + section + source.slice(end) + decoy
    }, /retirement PG17 ACL evidence is incomplete: get_token_ranking_publication_head/u)
  }
})

test('requires the asserted ACL value to come from the same psql assignment', () => {
  assertRetirementPg17MutationRejected((source) => {
    const assertion =
      `assert_equal \\\n` +
      `  "retirement keeps only service head EXECUTE and closes delegated functions/MVs" \\\n` +
      `  "true|false|false|false|false|false|false" \\\n` +
      `  "$RUNTIME_ACL"`
    assert.ok(source.includes(assertion))
    return source.replace(
      assertion,
      `UNBOUND_RUNTIME_ACL="$RUNTIME_ACL"\n` +
        assertion.replace('$RUNTIME_ACL', '$UNBOUND_RUNTIME_ACL')
    )
  }, /retirement PG17 ACL evidence is incomplete: get_token_ranking_publication_head/u)
})

test('requires owner-only ACL signatures inside the asserted closed-function query', () => {
  const signature = 'public.get_token_trader_rankings_v2(text,integer,integer,integer,bigint)'
  assertRetirementPg17MutationRejected((source) => {
    const start = source.indexOf('RUNTIME_MATRIX="$(psql_db -Atqc "')
    const end = source.indexOf('\n\nset +e', start)
    assert.ok(start >= 0 && end > start)
    const exactEntry = `('${signature}'::pg_catalog.regprocedure)`
    const section = source.slice(start, end)
    assert.ok(section.includes(exactEntry))
    return (
      source.slice(0, start) +
      section.replace(exactEntry, "('public.removed_v2(integer)'::pg_catalog.regprocedure)") +
      source.slice(end) +
      `\nOWNER_SIGNATURE_DECOY="${exactEntry}"\n` +
      `echo "$OWNER_SIGNATURE_DECOY" >/dev/null\n`
    )
  }, /retirement PG17 owner-only ACL evidence is incomplete: get_token_trader_rankings_v2/u)
})

test('fails closed when explicit service-role ACL statements drift', () => {
  const inventory = buildLaunchMigrationInventory({ repoRoot: ROOT })
  const definition = MISSING_RPC_DEFINITIONS[0]
  const migrationFile = definition.definingMigration
  const repoRoot = copyCrosswalkEvidenceRepo()
  try {
    const migrationPath = resolve(repoRoot, `supabase/migrations/${migrationFile}`)
    const original = readFileSync(migrationPath, 'utf8')
    const expectedGrant =
      'GRANT EXECUTE ON FUNCTION public.rerank_public_eligible_leaderboard(text)\n' +
      '  TO service_role;'
    assert.ok(original.includes(expectedGrant))
    const changed = Buffer.from(
      original.replace(expectedGrant, expectedGrant.replace('service_role', 'authenticated')) +
        `\n-- ${expectedGrant}\nSELECT '${expectedGrant}';\n`
    )
    writeFileSync(migrationPath, changed)
    assert.throws(
      () =>
        buildMissingRpcCrosswalk({
          inventory: reattestChangedMigration(inventory, migrationFile, changed),
          repoRoot,
        }),
      /does not grant only service_role EXECUTE/u
    )
  } finally {
    rmSync(repoRoot, { force: true, recursive: true })
  }
})

test('fails closed when retirement owner-only ACL gains a non-owner grant', () => {
  const inventory = buildLaunchMigrationInventory({ repoRoot: ROOT })
  const definition = MISSING_RPC_DEFINITIONS.find(
    (candidate) => candidate.name === 'get_token_trader_rankings_v2'
  )
  assert.ok(definition)
  const migrationFile = definition.aclEvidence.migration
  const repoRoot = copyCrosswalkEvidenceRepo()
  try {
    const migrationPath = resolve(repoRoot, `supabase/migrations/${migrationFile}`)
    const original = readFileSync(migrationPath, 'utf8')
    const anchor =
      'GRANT EXECUTE ON FUNCTION public.get_token_ranking_publication_head()\n' +
      '  TO service_role;'
    assert.ok(original.includes(anchor))
    const unsafeGrant =
      'GRANT EXECUTE ON FUNCTION public.get_token_trader_rankings_v2(\n' +
      '  text, integer, integer, integer, bigint\n' +
      ') TO service_role;\n\n'
    const changed = Buffer.from(original.replace(anchor, `${unsafeGrant}${anchor}`))
    writeFileSync(migrationPath, changed)
    assert.throws(
      () =>
        buildMissingRpcCrosswalk({
          inventory: reattestChangedMigration(inventory, migrationFile, changed),
          repoRoot,
        }),
      /unexpectedly grants non-owner EXECUTE/u
    )
  } finally {
    rmSync(repoRoot, { force: true, recursive: true })
  }
})

test('fails closed when either real dynamic function REVOKE is deleted', () => {
  const scenarios = [
    {
      error: /must dynamically revoke PUBLIC with CASCADE/u,
      snippet:
        `    EXECUTE pg_catalog.format(\n` +
        `      'REVOKE ALL PRIVILEGES ON FUNCTION %I.%I(%s) FROM PUBLIC CASCADE',\n` +
        `      v_function.nspname,\n` +
        `      v_function.proname,\n` +
        `      v_function.arguments\n` +
        `    );\n`,
    },
    {
      error: /must dynamically revoke every named grantee with CASCADE/u,
      snippet:
        `      EXECUTE pg_catalog.format(\n` +
        `        'REVOKE ALL PRIVILEGES ON FUNCTION %I.%I(%s) FROM %I CASCADE',\n` +
        `        v_function.nspname,\n` +
        `        v_function.proname,\n` +
        `        v_function.arguments,\n` +
        `        v_grantee_name\n` +
        `      );\n`,
    },
  ]
  for (const scenario of scenarios) {
    assertRetirementAclMutationRejected((source) => {
      assert.ok(source.includes(scenario.snippet))
      return source.replace(scenario.snippet, '') + `\n/* ${scenario.snippet} */\n`
    }, scenario.error)
  }
})

test('fails closed when the real retirement ACL postflight is deleted', () => {
  assertRetirementAclMutationRejected((source) => {
    const opening = '\nDO $postflight$\n'
    const closing = '\n$postflight$;\n'
    const start = source.indexOf(opening)
    const end = source.indexOf(closing, start + opening.length)
    assert.ok(start >= 0 && end > start)
    const removed = source.slice(start, end + closing.length)
    return (
      source.slice(0, start) +
      source.slice(end + closing.length) +
      `\n/* deleted postflight cannot be forged here:${removed} */\n`
    )
  }, /exactly one real \$postflight\$ DO block/u)
})

test('fails closed when a function is removed from the expected OID set', () => {
  assertRetirementAclMutationRejected((source) => {
    const insert = source.indexOf('INSERT INTO pg_temp.token_ranking_retirement_expected_functions')
    const rowStart = source.indexOf(
      "  (\n    'public.get_token_trader_rankings_v2(text,integer,integer,integer,bigint)'::pg_catalog.regprocedure,",
      insert
    )
    const nextRow = source.indexOf("\n  (\n    'public.get_popular_tokens_v2", rowStart)
    assert.ok(insert >= 0 && rowStart > insert && nextRow > rowStart)
    const removed = source.slice(rowStart, nextRow)
    return source.slice(0, rowStart) + source.slice(nextRow) + `\n/* ${removed} */\n`
  }, /must contain exactly all seven function signatures/u)
})

test('CLI emits read-only JSON and rejects arguments', () => {
  const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.rpcs.length, 5)
  assert.equal(result.stdout.includes('postgres://'), false)
  assert.equal(result.stdout.includes('password'), false)

  const invalid = spawnSync(process.execPath, [SCRIPT, '--live'], { encoding: 'utf8' })
  assert.equal(invalid.status, 2)
  assert.match(invalid.stderr, /Usage:/u)
})

test('implementation has no network, database, or subprocess capability', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  assert.doesNotMatch(source, /\b(?:fetch|spawn|exec|DATABASE_URL|SUPABASE_SERVICE_ROLE_KEY)\b/u)
})

test('superseded cron-API originals must stay superseded and out of predeploy', () => {
  const inventory = buildLaunchMigrationInventory({ repoRoot: ROOT })
  const original = '20260729230000_token_ranking_generation_barrier.sql'
  const reattest = (copy) => {
    for (const phase of copy.phases) {
      phase.count = phase.migrations.length
      phase.migrationSetSha256 = canonicalJsonSha256(phase.migrations)
    }
    const { inventorySha256: _oldDigest, ...attested } = copy
    copy.inventorySha256 = canonicalJsonSha256(attested)
    return copy
  }

  const unsuperseded = structuredClone(inventory)
  const supersededPhase = unsuperseded.phases.find((phase) => phase.name === 'superseded')
  supersededPhase.migrations = supersededPhase.migrations.filter(
    (migration) => migration.file !== original
  )
  assert.throws(
    () => buildMissingRpcCrosswalk({ inventory: reattest(unsuperseded), repoRoot: ROOT }),
    /superseded ranking migration must stay superseded: 20260729230000/u
  )

  const reentered = structuredClone(inventory)
  const originalEntry = reentered.phases
    .find((phase) => phase.name === 'superseded')
    .migrations.find((migration) => migration.file === original)
  reentered.phases.find((phase) => phase.name === 'predeploy').migrations.push(originalEntry)
  assert.throws(
    () => buildMissingRpcCrosswalk({ inventory: reattest(reentered), repoRoot: ROOT }),
    /superseded ranking migration re-entered predeploy: 20260729230000/u
  )
})
