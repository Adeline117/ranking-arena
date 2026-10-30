import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  chownSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  BASELINE_CANDIDATE_CONTRACT,
  CANDIDATE_STATUS,
  FOUNDATION_CONTRACT,
  FOUNDATION_STATUS,
  FORWARD_MIGRATIONS_CONTRACT,
  PLATFORM_PREREQUISITES_CONTRACT,
  SOURCE_CATALOG_CONTRACT,
  canonicalJsonSha256,
  validateAllBaselineCandidates,
  validateBaselineCandidate,
} from './validate-baseline-candidate.mjs'

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex')
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function tableCatalogRow(name) {
  return {
    forceRowSecurity: false,
    kind: 'r',
    name,
    owner: 'postgres',
    partitionBound: null,
    persistence: 'p',
    rowSecurity: false,
    schema: 'public',
  }
}

function makeFixture() {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'arena-baseline-validator-'))
  const repoRoot = path.join(tempRoot, 'repo')
  const candidatesRoot = path.join(repoRoot, 'supabase', 'baseline-candidates')
  const candidateDir = path.join(candidatesRoot, 'v1-observed')
  const migrationsDir = path.join(repoRoot, 'supabase', 'migrations')
  const foundationsDir = path.join(repoRoot, 'supabase', 'baseline-foundations')
  const foundationPath = path.join(foundationsDir, 'supabase-pg17.sql')
  mkdirSync(candidateDir, { recursive: true })
  chmodSync(candidateDir, 0o700)
  mkdirSync(migrationsDir, { recursive: true })
  mkdirSync(foundationsDir, { recursive: true })
  writeFileSync(foundationPath, 'CREATE SCHEMA auth;\nCREATE SCHEMA storage;\n')

  const boundaryPath = 'supabase/migrations/20260804000000_observed.sql'
  writeFileSync(
    path.join(repoRoot, boundaryPath),
    '-- Source-ledger boundary represented by the captured baseline.\n'
  )

  const migrationPaths = [
    'supabase/migrations/20260805010000_forward_one.sql',
    'supabase/migrations/20260805020000_forward_two.sql',
  ]
  for (const [index, migrationPath] of migrationPaths.entries()) {
    const absolute = path.join(repoRoot, migrationPath)
    writeFileSync(absolute, `CREATE TABLE public.forward_${index + 1} (id bigint);\n`)
  }

  writeFileSync(
    path.join(candidateDir, 'app-schema.sql'),
    `\\restrict ${'r'.repeat(63)}\n` +
      `CREATE TABLE public.widgets (id bigint PRIMARY KEY);\n\n` +
      `CREATE FUNCTION public.write_widget() RETURNS void\n` +
      `LANGUAGE plpgsql AS $body$\n` +
      `BEGIN\n  INSERT INTO public.widgets (id) VALUES (1);\n` +
      `  UPDATE public.widgets SET id = 2 WHERE id = 1;\nEND\n$body$;\n` +
      `COMMENT ON TABLE public.widgets IS 'DELETE FROM is documentation here';\n` +
      `\\unrestrict ${'r'.repeat(63)}\n`
  )

  const forwardMigrations = migrationPaths.map((migrationPath) => ({
    path: migrationPath,
    sha256: sha256(readFileSync(path.join(repoRoot, migrationPath))),
    version: path.basename(migrationPath).slice(0, 14),
  }))
  const repositoryMigrations = [
    {
      path: boundaryPath,
      sha256: sha256(readFileSync(path.join(repoRoot, boundaryPath))),
      version: '20260804000000',
    },
    ...forwardMigrations,
  ]
  const forward = {
    baselineThrough: '20260804000000',
    contract: FORWARD_MIGRATIONS_CONTRACT,
    migrationSetSha256: canonicalJsonSha256(forwardMigrations),
    migrations: forwardMigrations,
    repositoryMigrationSetSha256: canonicalJsonSha256(repositoryMigrations),
  }
  writeJson(path.join(candidateDir, 'forward-migrations.json'), forward)

  const catalog = {
    acls: [],
    columns: [],
    constraints: [],
    defaultPrivileges: [],
    extensions: [],
    functions: [],
    indexes: [],
    policies: [],
    publications: [],
    schemas: [],
    tables: [tableCatalogRow('widgets')],
    triggers: [],
    types: [],
    views: [],
  }
  const ledger = [
    {
      createdBy: null,
      idempotencyKey: null,
      name: 'observed',
      statementsSha256: 'e'.repeat(64),
      version: '20260804000000',
    },
  ]
  writeJson(path.join(candidateDir, 'source-catalog.json'), {
    capturedAt: '2026-08-04T21:30:00.000Z',
    catalog,
    contract: SOURCE_CATALOG_CONTRACT,
    ledger,
    postgresMajor: 17,
  })
  writeJson(path.join(candidateDir, 'platform-prerequisites.json'), {
    contract: PLATFORM_PREREQUISITES_CONTRACT,
    extensions: ['pgcrypto', 'uuid-ossp'],
    functions: ['auth.role()', 'auth.uid()'],
    postgresMajor: 17,
    relations: ['auth.users'],
    roles: ['anon', 'authenticated'],
    schemas: ['auth', 'storage'],
    types: ['auth.aal_level'],
  })

  const fixture = {
    candidateDir,
    candidatesRoot,
    boundaryPath,
    catalog,
    foundationPath,
    forward,
    ledger,
    migrationPaths,
    repoRoot,
    tempRoot,
  }
  refreshManifest(fixture)
  return fixture
}

function refreshManifest(fixture, mutate = () => {}) {
  const files = {}
  for (const fileName of [
    'app-schema.sql',
    'forward-migrations.json',
    'platform-prerequisites.json',
    'source-catalog.json',
  ]) {
    files[fileName] = sha256(readFileSync(path.join(fixture.candidateDir, fileName)))
  }
  const manifest = {
    contract: BASELINE_CANDIDATE_CONTRACT,
    files,
    foundation: {
      contract: FOUNDATION_CONTRACT,
      path: 'supabase/baseline-foundations/supabase-pg17.sql',
      postgresMajor: 17,
      sha256: sha256(readFileSync(fixture.foundationPath)),
      status: FOUNDATION_STATUS,
    },
    postgresMajor: 17,
    source: {
      capturedAt: '2026-08-04T21:30:00.000Z',
      catalogSha256: canonicalJsonSha256(fixture.catalog),
      gitSha: 'a'.repeat(40),
      ledgerSha256: canonicalJsonSha256(fixture.ledger),
      projectRefSha256: 'b'.repeat(64),
      transport: 'session-or-direct/verify-full/read-only',
    },
    status: CANDIDATE_STATUS,
  }
  mutate(manifest)
  writeJson(path.join(fixture.candidateDir, 'manifest.json'), manifest)
  for (const fileName of ['manifest.json', ...Object.keys(files)]) {
    chmodSync(path.join(fixture.candidateDir, fileName), 0o600)
  }
}

function validate(fixture) {
  return validateBaselineCandidate(fixture)
}

function cleanup(fixture) {
  rmSync(fixture.tempRoot, { recursive: true, force: true })
}

test('accepts a hash-pinned non-deployable PG17 candidate and ignores function-body DML', () => {
  const fixture = makeFixture()
  try {
    assert.deepEqual(validate(fixture), {
      baselineThrough: '20260804000000',
      candidate: 'supabase/baseline-candidates/v1-observed',
      migrationCount: 2,
      postgresMajor: 17,
      status: CANDIDATE_STATUS,
    })
  } finally {
    cleanup(fixture)
  }
})

test('the repository baseline-candidate inventory is always validated by the unit sweep', () => {
  assert.deepEqual(validateAllBaselineCandidates(), { candidateCount: 0, candidates: [] })
})

test('rejects top-level table data and sequence-state mutations', async (t) => {
  for (const [name, sql] of [
    ['copy', 'COPY public.widgets (id) FROM STDIN;\n1\n\\.\n'],
    ['insert', 'INSERT INTO public.widgets (id) VALUES (1);\n'],
    ['update', 'UPDATE public.widgets SET id = 2;\n'],
    ['delete', 'DELETE FROM public.widgets;\n'],
    ['truncate', 'TRUNCATE TABLE public.widgets;\n'],
    [
      'merge',
      'MERGE INTO public.widgets AS target USING public.widgets AS source ON false WHEN NOT MATCHED THEN DO NOTHING;\n',
    ],
    ['setval', "SELECT pg_catalog.setval('public.widgets_id_seq', 12);\n"],
  ]) {
    await t.test(name, () => {
      const fixture = makeFixture()
      try {
        writeFileSync(path.join(fixture.candidateDir, 'app-schema.sql'), sql)
        refreshManifest(fixture)
        assert.throws(() => validate(fixture), /forbidden|meta-command/)
      } finally {
        cleanup(fixture)
      }
    })
  }
})

test('rejects managed auth/storage DDL and migration-ledger references', async (t) => {
  for (const [name, sql, message] of [
    ['schema', 'CREATE SCHEMA auth;\n', /managed AUTH schema/],
    ['table', 'CREATE TABLE storage.objects_shadow (id bigint);\n', /managed STORAGE schema/],
    [
      'function',
      'CREATE OR REPLACE FUNCTION auth.shadow() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;\n',
      /managed AUTH schema/,
    ],
    [
      'policy',
      'CREATE POLICY unsafe ON storage.objects FOR SELECT USING (true);\n',
      /managed schema object/,
    ],
    [
      'ledger',
      'CREATE VIEW public.ledger_copy AS SELECT * FROM supabase_migrations.schema_migrations;\n',
      /Supabase migration ledger must not be referenced/,
    ],
  ]) {
    await t.test(name, () => {
      const fixture = makeFixture()
      try {
        writeFileSync(path.join(fixture.candidateDir, 'app-schema.sql'), sql)
        refreshManifest(fixture)
        assert.throws(() => validate(fixture), message)
      } finally {
        cleanup(fixture)
      }
    })
  }
})

test('fails closed on malformed SQL lexical states', async (t) => {
  for (const [name, sql, message] of [
    ['quote', "COMMENT ON TABLE public.widgets IS 'unterminated;\n", /unterminated string literal/],
    ['identifier', 'CREATE TABLE "unterminated (id bigint);\n', /unterminated quoted identifier/],
    ['comment', 'CREATE TABLE public.ok (id bigint); /* open\n', /unterminated block comment/],
    [
      'dollar body',
      'CREATE FUNCTION public.bad() RETURNS void LANGUAGE sql AS $bad$ SELECT 1;\n',
      /unterminated dollar-quoted body/,
    ],
  ]) {
    await t.test(name, () => {
      const fixture = makeFixture()
      try {
        writeFileSync(path.join(fixture.candidateDir, 'app-schema.sql'), sql)
        refreshManifest(fixture)
        assert.throws(() => validate(fixture), message)
      } finally {
        cleanup(fixture)
      }
    })
  }
})

test('rejects secrets and connection identifiers in every candidate artifact', () => {
  const fixture = makeFixture()
  try {
    writeFileSync(
      path.join(fixture.candidateDir, 'app-schema.sql'),
      "COMMENT ON SCHEMA public IS 'postgresql://admin:secret@db.example.invalid/postgres';\n"
    )
    refreshManifest(fixture)
    assert.throws(() => validate(fixture), /credential or connection identifier/)
  } finally {
    cleanup(fixture)
  }
})

test('uses the shared detector for Redis, GitHub, Stripe, and assignment credentials', async (t) => {
  for (const [name, credential] of [
    ['redis', 'redis://:redis_password_123456789@cache.example.invalid:6379/0'],
    ['github', `ghp_${'G'.repeat(32)}`],
    ['stripe', `sk_live_${'S'.repeat(24)}`],
    ['assignment', `DATABASE_PASSWORD="${'p'.repeat(24)}"`],
  ]) {
    await t.test(name, () => {
      const fixture = makeFixture()
      try {
        writeFileSync(
          path.join(fixture.candidateDir, 'app-schema.sql'),
          `COMMENT ON SCHEMA public IS '${credential.replaceAll("'", "''")}';\n`
        )
        refreshManifest(fixture)
        assert.throws(
          () => validate(fixture),
          (error) => {
            assert.match(error.message, /contains a credential or connection identifier/)
            assert.equal(error.message.includes(credential), false)
            return true
          }
        )
      } finally {
        cleanup(fixture)
      }
    })
  }
})

test('requires owner-controlled hierarchy and protocol permissions', async (t) => {
  for (const [name, mutate, message] of [
    [
      'repository root',
      (fixture) => chmodSync(fixture.repoRoot, 0o777),
      /not be group- or other-writable/,
    ],
    [
      'candidates root',
      (fixture) => chmodSync(fixture.candidatesRoot, 0o777),
      /not be group- or other-writable/,
    ],
    [
      'candidate directory',
      (fixture) => chmodSync(fixture.candidateDir, 0o755),
      /exact 0700 permissions/,
    ],
    [
      'candidate artifact',
      (fixture) => chmodSync(path.join(fixture.candidateDir, 'app-schema.sql'), 0o644),
      /exact 0600 permissions/,
    ],
    [
      'foundation',
      (fixture) => chmodSync(fixture.foundationPath, 0o666),
      /not be group- or other-writable/,
    ],
    [
      'migration',
      (fixture) => chmodSync(path.join(fixture.repoRoot, fixture.migrationPaths[0]), 0o666),
      /not be group- or other-writable/,
    ],
  ]) {
    await t.test(name, () => {
      const fixture = makeFixture()
      try {
        mutate(fixture)
        assert.throws(() => validate(fixture), message)
      } finally {
        cleanup(fixture)
      }
    })
  }
})

test('fails closed when effective user identity is unavailable', () => {
  const fixture = makeFixture()
  const originalGeteuid = process.geteuid
  try {
    process.geteuid = undefined
    assert.throws(() => validate(fixture), /effective user identity is unavailable/)
  } finally {
    process.geteuid = originalGeteuid
    cleanup(fixture)
  }
})

test('rejects filesystem evidence owned by neither root nor the effective user', () => {
  const fixture = makeFixture()
  const originalGeteuid = process.geteuid
  try {
    const euid = originalGeteuid()
    if (euid === 0) {
      chownSync(path.join(fixture.candidateDir, 'app-schema.sql'), 1, 1)
    } else {
      process.geteuid = () => euid + 1
    }
    assert.throws(() => validate(fixture), /must be owned by root or the effective user/)
  } finally {
    process.geteuid = originalGeteuid
    cleanup(fixture)
  }
})

test('rejects regular-file and symlink replacement between lstat and O_NOFOLLOW open', async (t) => {
  for (const scenario of ['regular replacement', 'symlink replacement']) {
    await t.test(scenario, () => {
      const fixture = makeFixture()
      let replaced = false
      try {
        assert.throws(
          () =>
            validateBaselineCandidate({
              ...fixture,
              testHooks: {
                afterLstatBeforeOpen: ({ label, path: target }) => {
                  if (replaced || label !== 'app-schema.sql') return
                  replaced = true
                  const original = `${target}.original`
                  renameSync(target, original)
                  if (scenario === 'symlink replacement') {
                    symlinkSync(original, target)
                  } else {
                    writeFileSync(target, readFileSync(original), { mode: 0o600 })
                    chmodSync(target, 0o600)
                  }
                },
              },
            }),
          /changed while it was being opened|could not be opened without following symbolic links/
        )
        assert.equal(replaced, true)
      } finally {
        cleanup(fixture)
      }
    })
  }
})

test('final pass rejects candidate, foundation, and migration evidence drift', async (t) => {
  for (const [name, mutate] of [
    [
      'candidate artifact',
      (fixture) =>
        writeFileSync(
          path.join(fixture.candidateDir, 'app-schema.sql'),
          `${readFileSync(path.join(fixture.candidateDir, 'app-schema.sql'), 'utf8')}-- drift\n`
        ),
    ],
    [
      'foundation',
      (fixture) =>
        writeFileSync(
          fixture.foundationPath,
          `${readFileSync(fixture.foundationPath, 'utf8')}-- drift\n`
        ),
    ],
    [
      'migration',
      (fixture) => {
        const target = path.join(fixture.repoRoot, fixture.migrationPaths[0])
        writeFileSync(target, `${readFileSync(target, 'utf8')}-- drift\n`)
      },
    ],
  ]) {
    await t.test(name, () => {
      const fixture = makeFixture()
      let mutated = false
      try {
        assert.throws(
          () =>
            validateBaselineCandidate({
              ...fixture,
              testHooks: {
                beforeFinalVerification: () => {
                  if (mutated) return
                  mutated = true
                  mutate(fixture)
                },
              },
            }),
          /changed during candidate validation/
        )
        assert.equal(mutated, true)
      } finally {
        cleanup(fixture)
      }
    })
  }
})

test('final pass re-enumerates candidate artifacts and the modern migration inventory', async (t) => {
  for (const [name, mutate, message] of [
    [
      'candidate artifact set',
      (fixture) => writeFileSync(path.join(fixture.candidateDir, 'late.sql'), 'SELECT 1;\n'),
      /candidate directory changed during candidate validation|must contain exactly/,
    ],
    [
      'migration inventory',
      (fixture) =>
        writeFileSync(
          path.join(fixture.repoRoot, 'supabase/migrations/20260806000000_late.sql'),
          'SELECT 1;\n'
        ),
      /migration directory changed during candidate validation|migration inventory changed/,
    ],
  ]) {
    await t.test(name, () => {
      const fixture = makeFixture()
      try {
        assert.throws(
          () =>
            validateBaselineCandidate({
              ...fixture,
              testHooks: { beforeFinalVerification: () => mutate(fixture) },
            }),
          message
        )
      } finally {
        cleanup(fixture)
      }
    })
  }
})

test('includeReplayPlan returns final pinned bytes and complete filesystem identities', () => {
  const fixture = makeFixture()
  try {
    const result = validateBaselineCandidate({ ...fixture, includeReplayPlan: true })
    for (const file of [
      result.replayPlan.appSchema,
      result.replayPlan.forwardManifest,
      result.replayPlan.foundation,
      result.replayPlan.platformPrerequisitesFile,
      result.replayPlan.sourceCatalog,
      ...result.replayPlan.forwardMigrations,
    ]) {
      assert.equal(Buffer.isBuffer(file.contents), true)
      assert.equal(sha256(file.contents), file.sha256)
      assert.deepEqual(Object.keys(file.identity).sort(), [
        'ctimeNs',
        'dev',
        'ino',
        'mode',
        'mtimeNs',
        'size',
        'uid',
      ])
    }
  } finally {
    cleanup(fixture)
  }
})

test('rejects mutable status, PostgreSQL version, artifact digest, and catalogue digest drift', async (t) => {
  for (const scenario of ['status', 'postgres', 'artifact', 'catalog']) {
    await t.test(scenario, () => {
      const fixture = makeFixture()
      try {
        if (scenario === 'status') {
          refreshManifest(fixture, (manifest) => {
            manifest.status = 'deployable'
          })
        } else if (scenario === 'postgres') {
          refreshManifest(fixture, (manifest) => {
            manifest.postgresMajor = 16
          })
        } else if (scenario === 'artifact') {
          writeFileSync(
            path.join(fixture.candidateDir, 'app-schema.sql'),
            'CREATE TABLE public.changed (id bigint);\n'
          )
        } else {
          refreshManifest(fixture, (manifest) => {
            manifest.source.catalogSha256 = 'c'.repeat(64)
          })
        }
        assert.throws(
          () => validate(fixture),
          /status must remain|postgresMajor must be 17|digest does not match|catalog digest does not match/
        )
      } finally {
        cleanup(fixture)
      }
    })
  }
})

test('rejects unsafe, out-of-order, missing, and content-drifted forward migrations', async (t) => {
  for (const scenario of ['path traversal', 'descending', 'missing', 'sha drift']) {
    await t.test(scenario, () => {
      const fixture = makeFixture()
      try {
        const forwardPath = path.join(fixture.candidateDir, 'forward-migrations.json')
        const document = structuredClone(fixture.forward)
        if (scenario === 'path traversal') {
          document.migrations[0].path = '../outside.sql'
        } else if (scenario === 'descending') {
          document.migrations.reverse()
        } else if (scenario === 'missing') {
          document.migrations[0].path = 'supabase/migrations/20260805010000_missing.sql'
        } else {
          document.migrations[0].sha256 = 'd'.repeat(64)
        }
        document.migrationSetSha256 = canonicalJsonSha256(document.migrations)
        writeJson(forwardPath, document)
        refreshManifest(fixture)
        assert.throws(
          () => validate(fixture),
          /matching repo-relative modern migration path|strictly increasing|does not exist|sha256 does not match/
        )
      } finally {
        cleanup(fixture)
      }
    })
  }
})

test('rejects symlinked candidate artifacts and migration files', async (t) => {
  for (const scenario of ['artifact', 'migration']) {
    await t.test(scenario, () => {
      const fixture = makeFixture()
      try {
        const external = path.join(fixture.tempRoot, `${scenario}.sql`)
        writeFileSync(external, 'SELECT 1;\n')
        const target =
          scenario === 'artifact'
            ? path.join(fixture.candidateDir, 'app-schema.sql')
            : path.join(fixture.repoRoot, fixture.migrationPaths[0])
        rmSync(target)
        symlinkSync(external, target)
        assert.throws(() => validate(fixture), /non-symlink|must not contain a symlink/)
      } finally {
        cleanup(fixture)
      }
    })
  }
})

test('requires sorted, duplicate-free platform prerequisites', () => {
  const fixture = makeFixture()
  try {
    const prerequisitePath = path.join(fixture.candidateDir, 'platform-prerequisites.json')
    const prerequisites = JSON.parse(readFileSync(prerequisitePath, 'utf8'))
    prerequisites.roles = ['authenticated', 'anon']
    writeJson(prerequisitePath, prerequisites)
    refreshManifest(fixture)
    assert.throws(() => validate(fixture), /must be sorted and contain no duplicates/)
  } finally {
    cleanup(fixture)
  }
})

test('requires managed relation and type prerequisites in the exact platform contract', () => {
  const fixture = makeFixture()
  try {
    const prerequisitePath = path.join(fixture.candidateDir, 'platform-prerequisites.json')
    const prerequisites = JSON.parse(readFileSync(prerequisitePath, 'utf8'))
    delete prerequisites.relations
    writeJson(prerequisitePath, prerequisites)
    refreshManifest(fixture)
    assert.throws(() => validate(fixture), /platform-prerequisites\.json must contain exactly/)
  } finally {
    cleanup(fixture)
  }
})

test('requires a hash-pinned non-production foundation contract', async (t) => {
  for (const scenario of ['status', 'hash', 'path']) {
    await t.test(scenario, () => {
      const fixture = makeFixture()
      try {
        refreshManifest(fixture, (manifest) => {
          if (scenario === 'status') manifest.foundation.status = 'production-ready'
          if (scenario === 'hash') manifest.foundation.sha256 = 'f'.repeat(64)
          if (scenario === 'path') manifest.foundation.path = '../outside.sql'
        })
        assert.throws(
          () => validate(fixture),
          /foundation status must remain|foundation sha256 does not match|foundation path must name/
        )
      } finally {
        cleanup(fixture)
      }
    })
  }
})

test('rejects an omitted forward migration even when the declared set digest is recomputed', () => {
  const fixture = makeFixture()
  try {
    const forwardPath = path.join(fixture.candidateDir, 'forward-migrations.json')
    const document = structuredClone(fixture.forward)
    document.migrations.pop()
    document.migrationSetSha256 = canonicalJsonSha256(document.migrations)
    writeJson(forwardPath, document)
    refreshManifest(fixture)
    assert.throws(
      () => validate(fixture),
      /must list every modern migration newer than baselineThrough/
    )
  } finally {
    cleanup(fixture)
  }
})

test('invalidates a candidate when a backdated modern migration is added after capture', () => {
  const fixture = makeFixture()
  try {
    writeFileSync(
      path.join(fixture.repoRoot, 'supabase/migrations/20260803000000_backdated.sql'),
      'CREATE TABLE public.backdated (id bigint);\n'
    )
    assert.throws(
      () => validate(fixture),
      /repositoryMigrationSetSha256 does not match the complete modern migration inventory/
    )
  } finally {
    cleanup(fixture)
  }
})

test('binds baselineThrough to one existing latest modern source-ledger boundary', async (t) => {
  for (const scenario of [
    'future boundary',
    'missing repository boundary',
    'duplicate ledger version',
  ]) {
    await t.test(scenario, () => {
      const fixture = makeFixture()
      try {
        const forwardPath = path.join(fixture.candidateDir, 'forward-migrations.json')
        const sourcePath = path.join(fixture.candidateDir, 'source-catalog.json')
        const forward = structuredClone(fixture.forward)
        const source = JSON.parse(readFileSync(sourcePath, 'utf8'))

        if (scenario === 'future boundary') {
          forward.baselineThrough = '99999999999999'
          forward.migrations = []
          forward.migrationSetSha256 = canonicalJsonSha256(forward.migrations)
        } else if (scenario === 'missing repository boundary') {
          forward.baselineThrough = '20260804000001'
          source.ledger[0].version = forward.baselineThrough
          fixture.ledger = source.ledger
        } else {
          source.ledger.push({
            createdBy: null,
            idempotencyKey: null,
            name: 'z_duplicate',
            statementsSha256: 'f'.repeat(64),
            version: source.ledger[0].version,
          })
          fixture.ledger = source.ledger
        }

        writeJson(forwardPath, forward)
        writeJson(sourcePath, source)
        refreshManifest(fixture)
        assert.throws(
          () => validate(fixture),
          /must equal the latest unique|must name an existing modern migration|duplicates modern source ledger/
        )
      } finally {
        cleanup(fixture)
      }
    })
  }
})

test('rejects extra candidate artifacts and non-canonical source catalogue arrays', async (t) => {
  await t.test('extra artifact', () => {
    const fixture = makeFixture()
    try {
      writeFileSync(path.join(fixture.candidateDir, 'unreviewed.sql'), 'SELECT 1;\n')
      assert.throws(() => validate(fixture), /candidate directory must contain exactly/)
    } finally {
      cleanup(fixture)
    }
  })

  await t.test('catalog order', () => {
    const fixture = makeFixture()
    try {
      const sourcePath = path.join(fixture.candidateDir, 'source-catalog.json')
      const source = JSON.parse(readFileSync(sourcePath, 'utf8'))
      source.catalog.tables = [tableCatalogRow('z'), tableCatalogRow('a')]
      writeJson(sourcePath, source)
      fixture.catalog = source.catalog
      refreshManifest(fixture)
      assert.throws(() => validate(fixture), /canonically sorted and contain no duplicates/)
    } finally {
      cleanup(fixture)
    }
  })

  await t.test('catalog row contract', () => {
    const fixture = makeFixture()
    try {
      const sourcePath = path.join(fixture.candidateDir, 'source-catalog.json')
      const source = JSON.parse(readFileSync(sourcePath, 'utf8'))
      delete source.catalog.tables[0].owner
      writeJson(sourcePath, source)
      fixture.catalog = source.catalog
      refreshManifest(fixture)
      assert.throws(() => validate(fixture), /catalog tables\[0\] must contain exactly/u)
    } finally {
      cleanup(fixture)
    }
  })

  await t.test('ledger row contract', () => {
    const fixture = makeFixture()
    try {
      const sourcePath = path.join(fixture.candidateDir, 'source-catalog.json')
      const source = JSON.parse(readFileSync(sourcePath, 'utf8'))
      delete source.ledger[0].idempotencyKey
      writeJson(sourcePath, source)
      fixture.ledger = source.ledger
      refreshManifest(fixture)
      assert.throws(() => validate(fixture), /ledger\[0\] must contain exactly/u)
    } finally {
      cleanup(fixture)
    }
  })
})
