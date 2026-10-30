import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  _assemblerContractForTests,
  assembleCanonicalBaselineCandidate,
  runCli,
} from './assemble-canonical-baseline-candidate.mjs'
import {
  CANDIDATE_STATUS,
  PLATFORM_PREREQUISITES_CONTRACT,
  SOURCE_CATALOG_CONTRACT,
  validateBaselineCandidate,
} from '../qa/validate-baseline-candidate.mjs'

const ASSEMBLER_SOURCE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'assemble-canonical-baseline-candidate.mjs'
)

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex')
}

function writePrivate(filePath, contents) {
  writeFileSync(filePath, contents, { mode: 0o600 })
  chmodSync(filePath, 0o600)
}

function writeJson(filePath, value, { privateFile = false } = {}) {
  const contents = `${JSON.stringify(value, null, 2)}\n`
  if (privateFile) writePrivate(filePath, contents)
  else writeFileSync(filePath, contents)
}

function tableCatalogRow(name = 'widgets') {
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

function sourceCatalog() {
  return {
    capturedAt: '2026-08-04T21:30:00.000Z',
    catalog: {
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
      tables: [tableCatalogRow()],
      triggers: [],
      types: [],
      views: [],
    },
    contract: SOURCE_CATALOG_CONTRACT,
    ledger: [
      {
        createdBy: null,
        idempotencyKey: null,
        name: 'observed',
        statementsSha256: 'e'.repeat(64),
        version: '20260804000000',
      },
    ],
    postgresMajor: 17,
  }
}

function prerequisites() {
  return {
    contract: PLATFORM_PREREQUISITES_CONTRACT,
    extensions: ['pgcrypto', 'uuid-ossp'],
    functions: ['auth.role()', 'auth.uid()'],
    postgresMajor: 17,
    relations: ['auth.users'],
    roles: ['anon', 'authenticated'],
    schemas: ['auth', 'storage'],
    types: ['auth.aal_level'],
  }
}

function makeFixture() {
  const tempRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'arena-candidate-assembler-')))
  const repoRoot = path.join(tempRoot, 'repo')
  const candidatesRoot = path.join(repoRoot, 'supabase', 'baseline-candidates')
  const foundationsRoot = path.join(repoRoot, 'supabase', 'baseline-foundations')
  const migrationsRoot = path.join(repoRoot, 'supabase', 'migrations')
  const sourceCaptureDir = path.join(tempRoot, 'source-capture')
  mkdirSync(candidatesRoot, { recursive: true })
  mkdirSync(foundationsRoot, { recursive: true })
  mkdirSync(migrationsRoot, { recursive: true })
  mkdirSync(sourceCaptureDir, { mode: 0o700 })
  chmodSync(sourceCaptureDir, 0o700)

  writePrivate(
    path.join(sourceCaptureDir, 'app-schema.sql'),
    `\\restrict ${'r'.repeat(63)}\n` +
      'CREATE TABLE public.widgets (id bigint PRIMARY KEY);\n' +
      `\\unrestrict ${'r'.repeat(63)}\n`
  )
  writeJson(path.join(sourceCaptureDir, 'source-catalog.json'), sourceCatalog(), {
    privateFile: true,
  })

  const foundationPath = 'supabase/baseline-foundations/supabase-pg17.sql'
  writeFileSync(
    path.join(repoRoot, foundationPath),
    'CREATE SCHEMA auth;\nCREATE SCHEMA storage;\n'
  )
  const migrationPaths = [
    'supabase/migrations/20260805010000_forward_one.sql',
    'supabase/migrations/20260805020000_forward_two.sql',
  ]
  writeFileSync(
    path.join(migrationsRoot, '20260804000000_observed.sql'),
    '-- Source-ledger boundary represented by the captured baseline.\n'
  )
  for (const [index, migrationPath] of migrationPaths.entries()) {
    writeFileSync(
      path.join(repoRoot, migrationPath),
      `CREATE TABLE public.forward_${index + 1} (id bigint);\n`
    )
  }
  const platformPrerequisitesPath = path.join(tempRoot, 'platform-prerequisites.json')
  writeJson(platformPrerequisitesPath, prerequisites())

  const options = {
    baselineThrough: '20260804000000',
    candidateName: 'v1-observed',
    candidatesRoot,
    foundationPath,
    forwardMigrationPaths: migrationPaths,
    platformPrerequisitesPath,
    projectRefSha256: 'b'.repeat(64),
    repoRoot,
    sourceCaptureDir,
    sourceGitSha: 'a'.repeat(40),
  }
  return {
    candidatesRoot,
    cleanup: () => rmSync(tempRoot, { force: true, recursive: true }),
    migrationPaths,
    options,
    platformPrerequisitesPath,
    repoRoot,
    sourceCaptureDir,
    tempRoot,
  }
}

function targetFor(fixture, name = fixture.options.candidateName) {
  return path.join(fixture.candidatesRoot, name)
}

function assertNoAssemblyResidue(fixture) {
  assert.equal(
    readdirSync(path.join(fixture.repoRoot, 'supabase')).some((name) =>
      name.startsWith('.arena-baseline-candidate-stage-')
    ),
    false
  )
}

test('assembles deterministic five-file evidence and delegates to the canonical validator', () => {
  const fixture = makeFixture()
  try {
    const first = assembleCanonicalBaselineCandidate(fixture.options)
    const firstTarget = targetFor(fixture)
    assert.deepEqual(first, {
      artifactCount: 5,
      baselineThrough: '20260804000000',
      candidate: 'supabase/baseline-candidates/v1-observed',
      manifestSha256: sha256(readFileSync(path.join(firstTarget, 'manifest.json'))),
      migrationCount: 2,
      postgresMajor: 17,
      status: CANDIDATE_STATUS,
    })
    assert.deepEqual(readdirSync(firstTarget).sort(), [
      'app-schema.sql',
      'forward-migrations.json',
      'manifest.json',
      'platform-prerequisites.json',
      'source-catalog.json',
    ])
    assert.deepEqual(
      validateBaselineCandidate({
        candidateDir: firstTarget,
        candidatesRoot: fixture.candidatesRoot,
        repoRoot: fixture.repoRoot,
      }),
      {
        baselineThrough: '20260804000000',
        candidate: 'supabase/baseline-candidates/v1-observed',
        migrationCount: 2,
        postgresMajor: 17,
        status: CANDIDATE_STATUS,
      }
    )
    const firstBytes = Object.fromEntries(
      _assemblerContractForTests.candidateArtifacts.map((name) => [
        name,
        readFileSync(path.join(firstTarget, name)),
      ])
    )

    const secondName = 'v1-observed-again'
    const second = assembleCanonicalBaselineCandidate({
      ...fixture.options,
      candidateName: secondName,
    })
    const secondTarget = targetFor(fixture, secondName)
    assert.equal(second.manifestSha256, first.manifestSha256)
    for (const name of _assemblerContractForTests.candidateArtifacts) {
      assert.deepEqual(readFileSync(path.join(secondTarget, name)), firstBytes[name])
      assert.equal(lstatMode(path.join(secondTarget, name)), 0o600)
    }
    assertNoAssemblyResidue(fixture)
  } finally {
    fixture.cleanup()
  }
})

function lstatMode(target) {
  return lstatSync(target).mode & 0o777
}

test('requires the exact explicit forward epoch and captured latest boundary', async (t) => {
  for (const scenario of ['omitted', 'reordered', 'boundary drift']) {
    await t.test(scenario, () => {
      const fixture = makeFixture()
      try {
        const options = { ...fixture.options }
        if (scenario === 'omitted') options.forwardMigrationPaths = [fixture.migrationPaths[0]]
        if (scenario === 'reordered') {
          options.forwardMigrationPaths = [...fixture.migrationPaths].reverse()
        }
        if (scenario === 'boundary drift') options.baselineThrough = '20260803000000'
        assert.throws(
          () => assembleCanonicalBaselineCandidate(options),
          /FORWARD_MIGRATION_SET_INCOMPLETE_OR_UNORDERED|SOURCE_LEDGER_BOUNDARY_MISMATCH/
        )
        assert.equal(pathExistsForTest(targetFor(fixture)), false)
        assertNoAssemblyResidue(fixture)
      } finally {
        fixture.cleanup()
      }
    })
  }
})

test('rejects incomplete, symlinked, secret-bearing, and malformed source evidence', async (t) => {
  for (const scenario of [
    'incomplete',
    'symlink',
    'secret',
    'catalog',
    'legacy contract',
    'column ACL',
    'function owner',
    'view reloptions',
  ]) {
    await t.test(scenario, () => {
      const fixture = makeFixture()
      try {
        if (scenario === 'incomplete') {
          writePrivate(
            path.join(fixture.sourceCaptureDir, '.arena-baseline-capture-incomplete'),
            'incomplete\n'
          )
        } else if (scenario === 'symlink') {
          const schemaPath = path.join(fixture.sourceCaptureDir, 'app-schema.sql')
          const external = path.join(fixture.tempRoot, 'external-schema.sql')
          writePrivate(external, readFileSync(schemaPath))
          rmSync(schemaPath)
          symlinkSync(external, schemaPath)
        } else if (scenario === 'secret') {
          writePrivate(
            path.join(fixture.sourceCaptureDir, 'app-schema.sql'),
            `\\restrict ${'r'.repeat(63)}\n` +
              "COMMENT ON SCHEMA public IS 'postgresql://admin:secret@example.invalid/postgres';\n" +
              `\\unrestrict ${'r'.repeat(63)}\n`
          )
        } else if (scenario === 'catalog') {
          const document = sourceCatalog()
          delete document.catalog.tables[0].owner
          writeJson(path.join(fixture.sourceCaptureDir, 'source-catalog.json'), document, {
            privateFile: true,
          })
        } else {
          const document = sourceCatalog()
          if (scenario === 'legacy contract') {
            document.contract = 'arena.canonical-baseline-source-catalog@2'
          } else if (scenario === 'column ACL') {
            document.catalog.columns = [
              {
                defaultExpression: null,
                generated: '',
                identity: '',
                name: 'id',
                notNull: true,
                ordinal: 1,
                relation: 'widgets',
                schema: 'public',
                type: 'bigint',
              },
            ]
          } else if (scenario === 'function owner') {
            document.catalog.functions = [
              {
                configuration: null,
                definition:
                  "CREATE FUNCTION public.read_widget() RETURNS bigint LANGUAGE sql AS 'SELECT 1'",
                identityArguments: '',
                kind: 'f',
                language: 'sql',
                leakproof: false,
                name: 'read_widget',
                result: 'bigint',
                schema: 'public',
                securityDefiner: true,
                volatility: 'v',
              },
            ]
          } else {
            document.catalog.views = [
              {
                definition: ' SELECT widgets.id\n   FROM public.widgets;',
                kind: 'v',
                name: 'visible_widgets',
                owner: 'postgres',
                schema: 'public',
              },
            ]
          }
          writeJson(path.join(fixture.sourceCaptureDir, 'source-catalog.json'), document, {
            privateFile: true,
          })
        }
        assert.throws(
          () => assembleCanonicalBaselineCandidate(fixture.options),
          /SOURCE_CAPTURE_ARTIFACT_SET_INVALID|credential or connection identifier|source-catalog\.json contract must be|catalog (?:columns|functions|tables|views)\[0\] must contain exactly/u
        )
        assert.equal(pathExistsForTest(targetFor(fixture)), false)
        assertNoAssemblyResidue(fixture)
      } finally {
        fixture.cleanup()
      }
    })
  }
})

test('rejects unsafe names, traversal, and symlinked external inputs', async (t) => {
  await t.test('candidate traversal', () => {
    const fixture = makeFixture()
    try {
      assert.throws(
        () =>
          assembleCanonicalBaselineCandidate({
            ...fixture.options,
            candidateName: '../escaped',
          }),
        /CANDIDATE_NAME_INVALID/
      )
    } finally {
      fixture.cleanup()
    }
  })

  await t.test('foundation traversal', () => {
    const fixture = makeFixture()
    try {
      assert.throws(
        () =>
          assembleCanonicalBaselineCandidate({
            ...fixture.options,
            foundationPath: '../foundation.sql',
          }),
        /FOUNDATION_INPUT_INVALID/
      )
      assert.equal(pathExistsForTest(targetFor(fixture)), false)
    } finally {
      fixture.cleanup()
    }
  })

  await t.test('symlinked prerequisite', () => {
    const fixture = makeFixture()
    try {
      const realInput = path.join(fixture.tempRoot, 'real-prerequisites.json')
      const linkedInput = path.join(fixture.tempRoot, 'linked-prerequisites.json')
      writeJson(realInput, prerequisites())
      symlinkSync(realInput, linkedInput)
      assert.throws(
        () =>
          assembleCanonicalBaselineCandidate({
            ...fixture.options,
            platformPrerequisitesPath: linkedInput,
          }),
        /PLATFORM_PREREQUISITES_INPUT_INVALID/
      )
      assert.equal(pathExistsForTest(targetFor(fixture)), false)
    } finally {
      fixture.cleanup()
    }
  })
})

test('refuses overwrite without changing an existing candidate directory', () => {
  const fixture = makeFixture()
  try {
    const target = targetFor(fixture)
    mkdirSync(target)
    writeFileSync(path.join(target, 'owner-evidence.txt'), 'leave me\n')
    assert.throws(
      () => assembleCanonicalBaselineCandidate(fixture.options),
      /CANDIDATE_OUTPUT_ALREADY_EXISTS/
    )
    assert.equal(readFileSync(path.join(target, 'owner-evidence.txt'), 'utf8'), 'leave me\n')
    assertNoAssemblyResidue(fixture)
  } finally {
    fixture.cleanup()
  }
})

test('rejects a group-or-world-writable candidate root before claiming output', () => {
  const fixture = makeFixture()
  try {
    chmodSync(fixture.candidatesRoot, 0o777)
    assert.throws(
      () => assembleCanonicalBaselineCandidate(fixture.options),
      /BASELINE_CANDIDATES_ROOT_NOT_OWNER_CONTROLLED/
    )
    assert.equal(pathExistsForTest(targetFor(fixture)), false)
    assertNoAssemblyResidue(fixture)
  } finally {
    fixture.cleanup()
  }
})

test('fails closed when the effective owner identity is unavailable', () => {
  const fixture = makeFixture()
  const originalGeteuid = process.geteuid
  try {
    process.geteuid = undefined
    assert.throws(
      () => assembleCanonicalBaselineCandidate(fixture.options),
      /REPOSITORY_ROOT_NOT_OWNER_CONTROLLED/
    )
    assert.equal(pathExistsForTest(targetFor(fixture)), false)
    assertNoAssemblyResidue(fixture)
  } finally {
    process.geteuid = originalGeteuid
    fixture.cleanup()
  }
})

test('rechecks every owner-controlled output ancestor immediately before publication', async (t) => {
  for (const scenario of ['repository', 'candidate parent', 'candidate root']) {
    await t.test(scenario, () => {
      const fixture = makeFixture()
      try {
        const changedDirectory =
          scenario === 'repository'
            ? fixture.repoRoot
            : scenario === 'candidate parent'
              ? path.dirname(fixture.candidatesRoot)
              : fixture.candidatesRoot
        assert.throws(
          () =>
            assembleCanonicalBaselineCandidate({
              ...fixture.options,
              beforePublish: () => chmodSync(changedDirectory, 0o777),
            }),
          /REPOSITORY_NOT_OWNER_CONTROLLED_DURING_ASSEMBLY|BASELINE_CANDIDATES_PARENT_NOT_OWNER_CONTROLLED|BASELINE_CANDIDATES_ROOT_NOT_OWNER_CONTROLLED/
        )
        assert.equal(pathExistsForTest(targetFor(fixture)), false)
        assertNoAssemblyResidue(fixture)
      } finally {
        fixture.cleanup()
      }
    })
  }
})

test('detects every pinned-input drift after private validation and publishes nothing', async (t) => {
  for (const scenario of ['migration', 'new migration', 'capture', 'foundation', 'prerequisites']) {
    await t.test(scenario, () => {
      const fixture = makeFixture()
      try {
        const changedPath =
          scenario === 'migration'
            ? path.join(fixture.repoRoot, fixture.migrationPaths[0])
            : scenario === 'new migration'
              ? path.join(fixture.repoRoot, 'supabase/migrations/20260806000000_late_addition.sql')
              : scenario === 'capture'
                ? path.join(fixture.sourceCaptureDir, 'source-catalog.json')
                : scenario === 'foundation'
                  ? path.join(fixture.repoRoot, fixture.options.foundationPath)
                  : fixture.platformPrerequisitesPath
        assert.throws(
          () =>
            assembleCanonicalBaselineCandidate({
              ...fixture.options,
              beforePublish: () => {
                writeFileSync(changedPath, `${readMaybe(changedPath)}-- changed\n`)
              },
            }),
          /MIGRATION_INVENTORY_CHANGED_DURING_ASSEMBLY|SOURCE_CAPTURE_CHANGED_DURING_ASSEMBLY|FOUNDATION_CHANGED_DURING_ASSEMBLY|PLATFORM_PREREQUISITES_CHANGED_DURING_ASSEMBLY/
        )
        assert.equal(pathExistsForTest(targetFor(fixture)), false)
        assertNoAssemblyResidue(fixture)
      } finally {
        fixture.cleanup()
      }
    })
  }
})

function readMaybe(target) {
  return pathExistsForTest(target) ? readFileSync(target, 'utf8') : ''
}

test('rolls back its exact output claim when linking or marker commit fails', async (t) => {
  await t.test('link failure', () => {
    const fixture = makeFixture()
    try {
      let calls = 0
      assert.throws(
        () =>
          assembleCanonicalBaselineCandidate({
            ...fixture.options,
            publishLink: (source, destination) => {
              calls += 1
              if (calls === 3) throw new Error('injected link failure')
              linkSync(source, destination)
            },
          }),
        /injected link failure/
      )
      assert.equal(pathExistsForTest(targetFor(fixture)), false)
      assertNoAssemblyResidue(fixture)
    } finally {
      fixture.cleanup()
    }
  })

  await t.test('commit failure', () => {
    const fixture = makeFixture()
    try {
      assert.throws(
        () =>
          assembleCanonicalBaselineCandidate({
            ...fixture.options,
            commitOutputMarker: () => {
              throw new Error('injected commit failure')
            },
          }),
        /injected commit failure/
      )
      assert.equal(pathExistsForTest(targetFor(fixture)), false)
      assertNoAssemblyResidue(fixture)
    } finally {
      fixture.cleanup()
    }
  })

  await t.test('commit callback unlinks then reports failure', () => {
    const fixture = makeFixture()
    try {
      assert.throws(
        () =>
          assembleCanonicalBaselineCandidate({
            ...fixture.options,
            commitOutputMarker: (markerPath) => {
              unlinkSync(markerPath)
              throw new Error('injected post-unlink failure')
            },
          }),
        /injected post-unlink failure/
      )
      assert.equal(pathExistsForTest(targetFor(fixture)), false)
      assertNoAssemblyResidue(fixture)
    } finally {
      fixture.cleanup()
    }
  })

  await t.test('post-commit validation drift', () => {
    const fixture = makeFixture()
    try {
      assert.throws(
        () =>
          assembleCanonicalBaselineCandidate({
            ...fixture.options,
            commitOutputMarker: (markerPath) => {
              unlinkSync(markerPath)
              writeFileSync(
                path.join(fixture.repoRoot, fixture.migrationPaths[0]),
                'CREATE TABLE public.changed_at_commit (id bigint);\n'
              )
            },
          }),
        /sha256 does not match|repositoryMigrationSetSha256 does not match/
      )
      assert.equal(pathExistsForTest(targetFor(fixture)), false)
      assertNoAssemblyResidue(fixture)
    } finally {
      fixture.cleanup()
    }
  })

  await t.test('post-commit candidate-root permission drift', () => {
    const fixture = makeFixture()
    try {
      assert.throws(
        () =>
          assembleCanonicalBaselineCandidate({
            ...fixture.options,
            commitOutputMarker: (markerPath) => {
              unlinkSync(markerPath)
              chmodSync(fixture.candidatesRoot, 0o777)
            },
          }),
        /BASELINE_CANDIDATES_ROOT_NOT_OWNER_CONTROLLED/
      )
      assert.equal(pathExistsForTest(targetFor(fixture)), false)
      assertNoAssemblyResidue(fixture)
    } finally {
      fixture.cleanup()
    }
  })

  await t.test('same-length published artifact tamper with restored mtime', () => {
    const fixture = makeFixture()
    try {
      let caught
      assert.throws(
        () =>
          assembleCanonicalBaselineCandidate({
            ...fixture.options,
            commitOutputMarker: (markerPath) => {
              const artifactPath = path.join(targetFor(fixture), 'app-schema.sql')
              const before = statSync(artifactPath)
              const changed = Buffer.from(readFileSync(artifactPath))
              changed[changed.indexOf('CREATE')] = 'X'.charCodeAt(0)
              writeFileSync(artifactPath, changed)
              utimesSync(artifactPath, before.atime, before.mtime)
              unlinkSync(markerPath)
            },
          }),
        (error) => {
          caught = error
          return true
        }
      )

      assert.equal(caught.message, 'ASSEMBLY_CLEANUP_FAILED')
      assert.equal(caught.cause?.message, 'CANDIDATE_OUTPUT_ARTIFACT_IDENTITY_INVALID')
      assert.equal(
        readFileSync(path.join(targetFor(fixture), '.arena-baseline-candidate-incomplete'), 'utf8'),
        'incomplete\n'
      )
      assertNoAssemblyResidue(fixture)
    } finally {
      fixture.cleanup()
    }
  })
})

test('fails closed when platform prerequisites cannot pass the existing validator', () => {
  const fixture = makeFixture()
  try {
    const document = prerequisites()
    document.roles = ['authenticated', 'anon']
    writeJson(fixture.platformPrerequisitesPath, document)
    assert.throws(
      () => assembleCanonicalBaselineCandidate(fixture.options),
      /must be sorted and contain no duplicates/
    )
    assert.equal(pathExistsForTest(targetFor(fixture)), false)
    assertNoAssemblyResidue(fixture)
  } finally {
    fixture.cleanup()
  }
})

test('CLI requires an explicit empty-or-complete forward choice and never echoes failures', async (t) => {
  await t.test('success', () => {
    let received
    let output = ''
    const code = runCli({
      argv: [
        '--candidate-name',
        'v1-empty',
        '--source-capture-dir',
        '/private/tmp/capture',
        '--source-git-sha',
        'a'.repeat(40),
        '--project-ref-sha256',
        'b'.repeat(64),
        '--foundation',
        'supabase/baseline-foundations/foundation.sql',
        '--platform-prerequisites',
        '/private/tmp/prerequisites.json',
        '--baseline-through',
        '20260804000000',
        '--no-forward-migrations',
      ],
      assemble: (options) => {
        received = options
        return { artifactCount: 5 }
      },
      writeOutput: (value) => {
        output += value
      },
    })
    assert.equal(code, 0)
    assert.deepEqual(received.forwardMigrationPaths, [])
    assert.match(output, /candidate\/not-deployable/)
  })

  await t.test('missing explicit forward choice', () => {
    let error = ''
    const code = runCli({
      argv: [],
      writeError: (value) => {
        error += value
      },
    })
    assert.equal(code, 2)
    assert.match(error, /^Usage:/)
  })

  await t.test('generic failure', () => {
    let error = ''
    const code = runCli({
      argv: [
        '--candidate-name',
        'v1-empty',
        '--source-capture-dir',
        '/private/tmp/capture',
        '--source-git-sha',
        'a'.repeat(40),
        '--project-ref-sha256',
        'b'.repeat(64),
        '--foundation',
        'supabase/baseline-foundations/foundation.sql',
        '--platform-prerequisites',
        '/private/tmp/prerequisites.json',
        '--baseline-through',
        '20260804000000',
        '--forward-migration',
        'supabase/migrations/20260805000000_forward.sql',
      ],
      assemble: () => {
        throw new Error('postgresql://admin:secret@example.invalid/postgres')
      },
      writeError: (value) => {
        error += value
      },
    })
    assert.equal(code, 2)
    assert.equal(error, 'Canonical baseline candidate assembly refused: ASSEMBLY_FAILED\n')
    assert.doesNotMatch(error, /admin|secret|postgres/)
  })
})

test('implementation is offline-only and retains the canonical validator boundary', () => {
  const source = readFileSync(ASSEMBLER_SOURCE, 'utf8')
  assert.doesNotMatch(source, /node:(?:child_process|http|https|net|tls)/u)
  assert.doesNotMatch(source, /\b(?:fetch|process\.env)\b/u)
  assert.doesNotMatch(source, /DATABASE_URL|SUPABASE_ACCESS_TOKEN|PGPASSWORD/u)
  assert.match(source, /validateBaselineCandidate\(/u)
  assert.match(source, /candidate\/not-deployable/u)
})

function pathExistsForTest(target) {
  try {
    lstatSync(target)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}
