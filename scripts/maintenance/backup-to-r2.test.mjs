import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { gunzipSync, gzipSync } from 'node:zlib'

import { arenaBackupCompletionSentinel } from './backup-restore-contract.mjs'

import {
  assertBackupArtifact,
  assertUploadedBackupObject,
  backupDateFromKey,
  buildBackupMetadata,
  buildBackupArtifactIdentity,
  COMPLETE_BACKUP_MIN_BYTES,
  IMMUTABLE_BACKUP_FILENAME_PATTERN,
  MULTIPART_PART_SIZE_BYTES,
  MULTIPART_QUEUE_SIZE,
  normalizeCompleteBackupSchemas,
  parseBackupMode,
  preparePgDumpConnection,
  produceAndCommitBackup,
  runPgDumpPipeline,
  uploadAndAttestBackupArtifact,
} from './backup-to-r2.mjs'
import { POSTGRES_CONNECTION_ENV_NAMES } from './postgres-cli-env.mjs'

const COMPLETION_TOKEN = 'a'.repeat(64)
const LEGACY_TOKEN = 'Z'.repeat(63)

function pgDumpFixture({ token = LEGACY_TOKEN, body = 'SELECT 1;\n', arenaToken } = {}) {
  const header = `--\n-- PostgreSQL database dump\n--\n\n\\restrict ${token}\n\n`
  const footer = `--\n-- PostgreSQL database dump complete\n--\n\n\\unrestrict ${token}\n\n`
  return header + body + footer + (arenaToken ? arenaBackupCompletionSentinel(arenaToken) : '')
}

function unrestrictedLegacyFixture(body = 'SELECT 1;\n') {
  return (
    '--\n-- PostgreSQL database dump\n--\n\n' +
    body +
    '--\n-- PostgreSQL database dump complete\n--\n\n'
  )
}

function successfulPgDumpShell(prelude = []) {
  return [
    '#!/bin/sh',
    ...prelude,
    'token=',
    'for arg in "$@"; do',
    '  case "$arg" in --restrict-key=*) token=${arg#*=} ;; esac',
    'done',
    '[ -n "$token" ] || exit 91',
    `printf '%s\\n' '--' '-- PostgreSQL database dump' '--' '' "\\restrict $token" '' 'SELECT 1;' '--' '-- PostgreSQL database dump complete' '--' '' "\\unrestrict $token" ''`,
    '',
  ].join('\n')
}

async function withTempDir(run) {
  const directory = await mkdtemp(join(tmpdir(), 'arena-backup-test-'))
  try {
    return await run(directory)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
}

async function writeExecutable(path, source) {
  await writeFile(path, source, 'utf8')
  await chmod(path, 0o700)
}

async function withProcessEnv(overrides, run) {
  const previous = new Map(Object.keys(overrides).map((name) => [name, process.env[name]]))
  Object.assign(process.env, overrides)
  try {
    return await run()
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

test('normalizes complete schema mode and rejects partial schema sets', () => {
  assert.deepEqual(normalizeCompleteBackupSchemas(' public,arena, public '), ['public', 'arena'])
  assert.deepEqual(normalizeCompleteBackupSchemas(''), [])
  assert.throws(() => normalizeCompleteBackupSchemas('public'), /requires both arena and public/)
  assert.throws(
    () => normalizeCompleteBackupSchemas('arena,extensions'),
    /requires both arena and public/
  )
  for (const managedSchema of ['auth', 'storage', 'realtime', 'supabase_migrations']) {
    assert.throws(
      () => normalizeCompleteBackupSchemas(`arena,public,${managedSchema}`),
      /supports exactly arena,public/
    )
  }
  assert.throws(
    () => normalizeCompleteBackupSchemas('arena,public,extensions'),
    /supports exactly arena,public/
  )
})

test('requires exactly one explicit complete backup mode', () => {
  assert.deepEqual(parseBackupMode({ argv: ['--full'], schemasEnv: '' }), {
    type: 'full',
    schemas: [],
  })
  assert.deepEqual(parseBackupMode({ argv: [], schemasEnv: 'public,arena' }), {
    type: 'schemas',
    schemas: ['public', 'arena'],
  })

  assert.throws(() => parseBackupMode({ argv: [], schemasEnv: '' }), /refusing incomplete backup/)
  assert.throws(
    () => parseBackupMode({ argv: ['--full'], schemasEnv: 'arena,public' }),
    /mutually exclusive/
  )
  assert.throws(
    () => parseBackupMode({ argv: ['--full', '--full'], schemasEnv: '' }),
    /only be specified once/
  )
  assert.throws(
    () => parseBackupMode({ argv: ['--legacy-tables'], schemasEnv: '' }),
    /unknown backup argument/
  )
})

test('builds unique timestamped artifact identities without credential-derived names', () => {
  const now = new Date('2026-08-04T07:08:09.123Z')
  const mode = parseBackupMode({ argv: [], schemasEnv: 'arena,public' })
  const first = buildBackupArtifactIdentity({ now, mode, runId: 'a'.repeat(32) })
  const second = buildBackupArtifactIdentity({ now, mode, runId: 'b'.repeat(32) })

  assert.equal(first.filename, `arena-backup-20260804T070809123Z-${'a'.repeat(32)}-schemas.sql.gz`)
  assert.equal(first.localPath, `/tmp/${first.filename}`)
  assert.equal(first.r2Key, `db-backups/2026/08/${first.filename}`)
  assert.deepEqual(first.filename.match(IMMUTABLE_BACKUP_FILENAME_PATTERN)?.slice(1), [
    '20260804T070809123Z',
    'a'.repeat(32),
    'schemas',
  ])
  assert.notEqual(first.filename, second.filename)
  assert.notEqual(first.localPath, second.localPath)
  assert.notEqual(first.r2Key, second.r2Key)
  assert.equal(backupDateFromKey(first.r2Key), '20260804')
  assert.equal(
    backupDateFromKey('db-backups/2026/07/arena-backup-20260731-schemas.sql.gz'),
    '20260731'
  )
  assert.equal(backupDateFromKey('db-backups/2026/06/arena-backup-20260612.sql.gz'), '20260612')
  assert.equal(backupDateFromKey('db-backups/not-a-backup-20260612.sql.gz'), '')

  const credential = 'postgresql://backup:do-not-leak@db.example.com/app'
  assert.throws(
    () => buildBackupArtifactIdentity({ now, mode, runId: credential }),
    (error) => {
      assert.match(error.message, /run id is invalid/)
      assert.equal(error.message.includes('do-not-leak'), false)
      return true
    }
  )
  assert.equal(JSON.stringify(first).includes('do-not-leak'), false)
})

test('uses managed multipart upload and attests the exact remote object through HEAD', async () => {
  await withTempDir(async (directory) => {
    const localPath = join(directory, 'artifact.sql.gz')
    await writeFile(localPath, 'fixture')
    const key = `db-backups/2026/08/arena-backup-20260804T070809123Z-${'b'.repeat(32)}-schemas.sql.gz`
    const mode = parseBackupMode({ argv: [], schemasEnv: 'arena,public' })
    const metadata = buildBackupMetadata({
      now: new Date('2026-08-04T07:08:09.123Z'),
      mode,
      completionToken: COMPLETION_TOKEN,
    })
    const events = []
    let uploadOptions

    class FakeUpload {
      constructor(options) {
        uploadOptions = options
      }

      async done() {
        events.push('multipart-done')
        uploadOptions.params.Body.destroy()
        return { ETag: '"multipart-etag-17"' }
      }
    }

    const client = {
      async send(command) {
        events.push('head')
        assert.deepEqual(command.input, {
          Bucket: 'arena-test',
          Key: key,
          IfMatch: '"multipart-etag-17"',
        })
        return {
          ContentLength: COMPLETE_BACKUP_MIN_BYTES,
          ContentType: 'application/gzip',
          ETag: '"multipart-etag-17"',
          Metadata: metadata,
        }
      },
    }

    const remote = await uploadAndAttestBackupArtifact({
      client,
      bucket: 'arena-test',
      key,
      localPath,
      size: COMPLETE_BACKUP_MIN_BYTES,
      metadata,
      UploadClass: FakeUpload,
    })

    assert.deepEqual(events, ['multipart-done', 'head'])
    assert.equal(uploadOptions.queueSize, MULTIPART_QUEUE_SIZE)
    assert.equal(uploadOptions.partSize, MULTIPART_PART_SIZE_BYTES)
    assert.equal(uploadOptions.leavePartsOnError, false)
    assert.equal(uploadOptions.params.ContentLength, COMPLETE_BACKUP_MIN_BYTES)
    assert.equal(uploadOptions.params.ContentType, 'application/gzip')
    assert.deepEqual(uploadOptions.params.Metadata, metadata)
    assert.deepEqual(
      {
        recoveryScope: metadata['recovery-scope'],
        authCoverage: metadata['auth-coverage'],
        targetModel: metadata['target-model'],
        recoveryCertified: metadata['recovery-certified'],
      },
      {
        recoveryScope: 'application-data-only',
        authCoverage: 'none',
        targetModel: 'unproven',
        recoveryCertified: 'false',
      }
    )
    assert.equal(remote.Size, COMPLETE_BACKUP_MIN_BYTES)
  })
})

test('remote upload attestation rejects size, ETag, content-type, and metadata drift', () => {
  const key = `db-backups/2026/08/arena-backup-20260804T070809123Z-${'c'.repeat(32)}-full.sql.gz`
  const metadata = buildBackupMetadata({
    now: new Date('2026-08-04T07:08:09.123Z'),
    mode: { type: 'full', schemas: [] },
    completionToken: COMPLETION_TOKEN,
  })
  const validHead = {
    ContentLength: COMPLETE_BACKUP_MIN_BYTES,
    ContentType: 'application/gzip',
    ETag: '"remote-etag-2"',
    Metadata: metadata,
  }
  const attest = (head, uploadETag = '"remote-etag-2"') =>
    assertUploadedBackupObject({
      key,
      expectedSize: COMPLETE_BACKUP_MIN_BYTES,
      expectedMetadata: metadata,
      uploadETag,
      head,
    })

  assert.doesNotThrow(() => attest(validHead))
  assert.equal(metadata['recovery-scope'], 'full-database-capture')
  assert.equal(metadata['auth-coverage'], 'captured-unverified')
  assert.equal(metadata['target-model'], 'unproven')
  assert.equal(metadata['recovery-certified'], 'false')
  assert.throws(
    () => attest({ ...validHead, ContentLength: COMPLETE_BACKUP_MIN_BYTES + 1 }),
    /size attestation failed/
  )
  assert.throws(() => attest(validHead, '"other-etag"'), /ETag attestation failed/)
  assert.throws(
    () => attest({ ...validHead, ContentType: 'application/octet-stream' }),
    /content type attestation failed/
  )
  assert.throws(
    () =>
      attest({
        ...validHead,
        Metadata: { ...metadata, 'completion-token': 'd'.repeat(64) },
      }),
    /metadata attestation failed: completion-token/
  )
})

test('moves an encoded authority password out of the pg_dump URL', () => {
  const result = preparePgDumpConnection(
    'postgresql://backup:p%40ss%3Aword@db.example.com:6543/app?sslmode=require'
  )

  assert.deepEqual(result, {
    connectionUrl: 'postgresql://backup@db.example.com:6543/app?sslmode=require',
    password: 'p@ss:word',
  })
  assert.equal(result.connectionUrl.includes('p%40ss'), false)
})

test('removes query-string passwords and preserves libpq precedence', () => {
  const result = preparePgDumpConnection(
    'postgres://backup:authority-secret@db.example.com/app?sslmode=verify-full&password=query+secret&application_name=arena+backup'
  )

  assert.deepEqual(result, {
    connectionUrl:
      'postgres://backup@db.example.com/app?sslmode=verify-full&application_name=arena+backup',
    password: 'query+secret',
  })
  assert.equal(result.connectionUrl.includes('authority-secret'), false)
  assert.equal(result.connectionUrl.includes('query'), false)
})

test('leaves passwordless URLs without manufacturing credentials', () => {
  assert.deepEqual(
    preparePgDumpConnection('postgresql://backup@db.example.com/app?sslmode=require'),
    {
      connectionUrl: 'postgresql://backup@db.example.com/app?sslmode=require',
      password: undefined,
    }
  )

  assert.deepEqual(preparePgDumpConnection('postgresql://db.example.com:6543/app'), {
    connectionUrl: 'postgresql://db.example.com:6543/app',
    password: undefined,
  })
})

test('preserves an explicitly empty URI password over an inherited password', () => {
  assert.deepEqual(preparePgDumpConnection('postgresql://backup:@db.example.com/app'), {
    connectionUrl: 'postgresql://backup@db.example.com/app',
    password: '',
  })
})

test('rejects URL fragments so hidden credentials never reach pg_dump argv', () => {
  assert.throws(
    () =>
      preparePgDumpConnection(
        'postgresql://backup@db.example.com/app?sslmode=require#password=fragment-secret'
      ),
    /DATABASE_URL fragments are unsupported/
  )
})

test('a failed pg_dump cannot be hidden by a successful gzip', async () => {
  await withTempDir(async (directory) => {
    const pgDump = join(directory, 'fake-pg-dump')
    const output = join(directory, 'failed.sql.gz')
    const bashEnv = join(directory, 'malicious-bash-env')
    const bashEnvMarker = join(directory, 'bash-env-sourced')
    let uploads = 0
    let prunes = 0
    await writeExecutable(pgDump, "#!/bin/sh\nprintf 'partial sql before failure\\n'\nexit 42\n")
    await writeFile(bashEnv, 'set +o pipefail\n: > "$BASH_ENV_MARKER"\n', 'utf8')

    await withProcessEnv(
      {
        BASH_ENV: bashEnv,
        ENV: bashEnv,
        BASH_ENV_MARKER: bashEnvMarker,
      },
      () =>
        assert.rejects(
          produceAndCommitBackup({
            produce: () =>
              runPgDumpPipeline({
                pgDumpPath: pgDump,
                connectionUrl: 'postgresql://backup@db.example.com/app',
                password: 'test-password',
                pgDumpArgs: ['--no-owner'],
                outputPath: output,
                completionToken: COMPLETION_TOKEN,
                timeoutMs: 5_000,
              }),
            localPath: output,
            minimumBytes: 1,
            completionToken: COMPLETION_TOKEN,
            upload: async () => {
              uploads += 1
            },
            prune: async () => {
              prunes += 1
            },
          }),
          (error) => error?.status === 42
        )
    )

    // gzip still emitted an artifact, proving the regression exercises the
    // exact false-success shape. Neither remote side effect was reached.
    assert.ok((await stat(output)).size > 0)
    assert.doesNotMatch(
      gunzipSync(await readFile(output)).toString('utf8'),
      /ARENA BACKUP COMPLETE/
    )
    assert.equal(uploads, 0)
    assert.equal(prunes, 0)
    await assert.rejects(stat(bashEnvMarker), { code: 'ENOENT' })
  })
})

test('passes literal argv and only target auth through a scrubbed pg_dump env', async () => {
  await withTempDir(async (directory) => {
    const pgDump = join(directory, 'fake-pg-dump')
    const output = join(directory, 'success.sql.gz')
    const argsLog = join(directory, 'args.log')
    const passwordLog = join(directory, 'password.log')
    const envLog = join(directory, 'env.log')
    const injectedPath = join(directory, 'must-not-exist')
    const ambient = Object.fromEntries(
      POSTGRES_CONNECTION_ENV_NAMES.map((name) => [name, `ambient-${name}`])
    )

    await withProcessEnv(
      {
        ...ambient,
        PGFUTURECONNECTIONOVERRIDE: 'future-redirect',
        DATABASE_URL: 'postgresql://ambient:secret@wrong.example.com/wrong',
        R2_ACCOUNT_ID: 'ambient-account',
        R2_ACCESS_KEY_ID: 'ambient-r2-access',
        R2_SECRET_ACCESS_KEY: 'ambient-r2-secret',
        R2_BUCKET: 'ambient-bucket',
        POSIXLY_CORRECT: '1',
        'BASH_FUNC_printf%%': '() { :; }',
        FAKE_ARGS_LOG: argsLog,
        FAKE_PASSWORD_LOG: passwordLog,
        FAKE_ENV_LOG: envLog,
      },
      async () => {
        await writeExecutable(
          pgDump,
          successfulPgDumpShell([
            'printf "%s\\n" "$@" > "$FAKE_ARGS_LOG"',
            'printf "%s" "$PGPASSWORD" > "$FAKE_PASSWORD_LOG"',
            'env > "$FAKE_ENV_LOG"',
          ])
        )
        const literalSchema = `arena; touch ${injectedPath}`
        runPgDumpPipeline({
          pgDumpPath: pgDump,
          connectionUrl: 'postgresql://backup@db.example.com/app?sslmode=require',
          password: 'p@ss:word',
          pgDumpArgs: ['-n', literalSchema, '--no-owner'],
          outputPath: output,
          completionToken: COMPLETION_TOKEN,
          timeoutMs: 5_000,
        })

        assert.deepEqual((await readFile(argsLog, 'utf8')).trim().split('\n'), [
          '-n',
          literalSchema,
          '--no-owner',
          `--restrict-key=${COMPLETION_TOKEN}`,
          'postgresql://backup@db.example.com/app?sslmode=require',
        ])
        assert.equal(await readFile(passwordLog, 'utf8'), 'p@ss:word')
        const childEnv = await readFile(envLog, 'utf8')
        assert.deepEqual(
          childEnv.split('\n').filter((line) => /^PG[A-Z0-9_]*=/.test(line)),
          ['PGPASSWORD=p@ss:word']
        )
        for (const name of [
          'DATABASE_URL',
          'R2_ACCOUNT_ID',
          'R2_ACCESS_KEY_ID',
          'R2_SECRET_ACCESS_KEY',
          'R2_BUCKET',
          'POSIXLY_CORRECT',
          'BASH_FUNC_printf%%',
        ]) {
          assert.doesNotMatch(childEnv, new RegExp(`^${name}=`, 'm'))
        }
        await assert.rejects(stat(injectedPath), { code: 'ENOENT' })
        assert.ok(
          (await assertBackupArtifact(output, 1, { completionToken: COMPLETION_TOKEN })) > 0
        )
      }
    )
  })
})

test('a passwordless target cannot inherit ambient libpq authentication variables', async () => {
  await withTempDir(async (directory) => {
    const pgDump = join(directory, 'fake-pg-dump')
    const output = join(directory, 'passwordless.sql.gz')
    const envLog = join(directory, 'env.log')
    await writeExecutable(pgDump, successfulPgDumpShell(['env > "$FAKE_ENV_LOG"']))

    await withProcessEnv(
      {
        PGPASSWORD: 'ambient-password',
        PGPASSFILE: '/ambient/pgpass',
        PGSERVICE: 'ambient-service',
        FAKE_ENV_LOG: envLog,
      },
      async () => {
        runPgDumpPipeline({
          pgDumpPath: pgDump,
          connectionUrl: 'postgresql://backup@db.example.com/app',
          password: undefined,
          pgDumpArgs: [],
          outputPath: output,
          completionToken: COMPLETION_TOKEN,
          timeoutMs: 5_000,
        })
      }
    )

    assert.doesNotMatch(await readFile(envLog, 'utf8'), /^PG[A-Z0-9_]*=/m)
    assert.ok((await assertBackupArtifact(output, 1, { completionToken: COMPLETION_TOKEN })) > 0)
  })
})

test('rejects undersized or corrupt artifacts before upload eligibility', async () => {
  await withTempDir(async (directory) => {
    const pgDump = join(directory, 'fake-pg-dump')
    const output = join(directory, 'small.sql.gz')
    let uploads = 0
    let prunes = 0
    const upload = async () => {
      uploads += 1
    }
    const prune = async () => {
      prunes += 1
    }
    await writeExecutable(pgDump, successfulPgDumpShell())
    await assert.rejects(
      produceAndCommitBackup({
        produce: () =>
          runPgDumpPipeline({
            pgDumpPath: pgDump,
            connectionUrl: 'postgresql://backup@db.example.com/app',
            password: undefined,
            pgDumpArgs: [],
            outputPath: output,
            completionToken: COMPLETION_TOKEN,
            timeoutMs: 5_000,
          }),
        localPath: output,
        minimumBytes: COMPLETE_BACKUP_MIN_BYTES,
        completionToken: COMPLETION_TOKEN,
        upload,
        prune,
      }),
      /backup artifact is incomplete/
    )
    assert.equal(uploads, 0)
    assert.equal(prunes, 0)

    await assert.rejects(
      produceAndCommitBackup({
        produce: () => writeFile(output, 'not a gzip', 'utf8'),
        localPath: output,
        minimumBytes: 1,
        completionToken: COMPLETION_TOKEN,
        upload,
        prune,
      }),
      /failed gzip or pg_dump completion verification/
    )
    assert.equal(uploads, 0)
    assert.equal(prunes, 0)
  })
})

test('uploads and prunes only after a valid artifact, then removes the local copy', async () => {
  await withTempDir(async (directory) => {
    const pgDump = join(directory, 'fake-pg-dump')
    const output = join(directory, 'valid.sql.gz')
    const events = []
    await writeExecutable(pgDump, successfulPgDumpShell())

    const size = await produceAndCommitBackup({
      produce: () =>
        runPgDumpPipeline({
          pgDumpPath: pgDump,
          connectionUrl: 'postgresql://backup@db.example.com/app',
          password: undefined,
          pgDumpArgs: [],
          outputPath: output,
          completionToken: COMPLETION_TOKEN,
          timeoutMs: 5_000,
        }),
      localPath: output,
      minimumBytes: 1,
      completionToken: COMPLETION_TOKEN,
      upload: async (validatedSize) => {
        events.push(`upload:${validatedSize}`)
        assert.equal((await stat(output)).size, validatedSize)
      },
      prune: async () => {
        events.push('prune')
      },
    })

    assert.deepEqual(events, [`upload:${size}`, 'prune'])
    await assert.rejects(stat(output), { code: 'ENOENT' })
  })
})

test('accepts exact PG17 legacy and Arena completion suffixes in one full gzip pass', async () => {
  await withTempDir(async (directory) => {
    const restricted = join(directory, 'restricted.sql.gz')
    const arena = join(directory, 'arena.sql.gz')
    await writeFile(restricted, gzipSync(pgDumpFixture()))
    await writeFile(
      arena,
      gzipSync(
        pgDumpFixture({
          token: COMPLETION_TOKEN,
          arenaToken: COMPLETION_TOKEN,
        })
      )
    )

    assert.ok((await assertBackupArtifact(restricted, 1)) > 0)
    assert.ok((await assertBackupArtifact(arena, 1, { completionToken: COMPLETION_TOKEN })) > 0)
  })
})

test('accepts the captured real pg_dump 17.8 native 63-character completion shape', async () => {
  await withTempDir(async (directory) => {
    const captured = Buffer.from(
      (
        await readFile(new URL('./fixtures/pg17.8-schema-only.sql.base64', import.meta.url), 'utf8')
      ).trim(),
      'base64'
    )
    const artifact = join(directory, 'captured-pg17.sql.gz')
    await writeFile(artifact, gzipSync(captured))
    assert.ok((await assertBackupArtifact(artifact, 1)) > 0)
  })
})

test('rejects semantic half-dumps, malformed or mismatched tokens, and bad gzip CRC', async () => {
  await withTempDir(async (directory) => {
    const officialFooter =
      `--\n-- PostgreSQL database dump complete\n--\n\n` + `\\unrestrict ${LEGACY_TOKEN}\n\n`
    const cases = [
      pgDumpFixture({ body: '-- PostgreSQL database dump complete\nSELECT 1;\n' }).replace(
        officialFooter,
        ''
      ),
      pgDumpFixture().replace(`\\unrestrict ${LEGACY_TOKEN}`, `\\unrestrict ${'Y'.repeat(63)}`),
      pgDumpFixture().replace(`\\restrict ${LEGACY_TOKEN}\n\n`, '\\restrict malformed-token!\n\n'),
      unrestrictedLegacyFixture(),
    ]

    for (const [index, dump] of cases.entries()) {
      const artifact = join(directory, `invalid-${index}.sql.gz`)
      await writeFile(artifact, gzipSync(dump))
      await assert.rejects(
        assertBackupArtifact(artifact, 1),
        /failed gzip or pg_dump completion verification/
      )
    }

    const badCrc = gzipSync(pgDumpFixture())
    badCrc[badCrc.length - 1] ^= 0xff
    const corrupt = join(directory, 'bad-crc.sql.gz')
    await writeFile(corrupt, badCrc)
    await assert.rejects(
      assertBackupArtifact(corrupt, 1),
      /failed gzip or pg_dump completion verification/
    )
  })
})

test('Arena metadata token must match restrict, unrestrict, and the exact EOF sentinel', async () => {
  await withTempDir(async (directory) => {
    const artifact = join(directory, 'arena-token-mismatch.sql.gz')
    await writeFile(
      artifact,
      gzipSync(
        pgDumpFixture({
          token: COMPLETION_TOKEN,
          arenaToken: COMPLETION_TOKEN,
        })
      )
    )

    await assert.rejects(
      assertBackupArtifact(artifact, 1, { completionToken: 'b'.repeat(64) }),
      /failed gzip or pg_dump completion verification/
    )
  })
})

test('keeps exact EOF semantics across a large multi-chunk tail window', async () => {
  await withTempDir(async (directory) => {
    const validArtifact = join(directory, 'large-valid.sql.gz')
    const trailingArtifact = join(directory, 'large-trailing.sql.gz')
    const decoyCompletion =
      `--\n-- PostgreSQL database dump complete\n--\n\n` +
      `\\unrestrict ${COMPLETION_TOKEN}\n\n` +
      arenaBackupCompletionSentinel(COMPLETION_TOKEN)
    const dump = pgDumpFixture({
      token: COMPLETION_TOKEN,
      body: decoyCompletion + 'x'.repeat(2 * 1024 * 1024) + '\n',
      arenaToken: COMPLETION_TOKEN,
    })
    await writeFile(validArtifact, gzipSync(dump))
    await writeFile(trailingArtifact, gzipSync(dump + 'trailing bytes after sentinel\n'))

    assert.ok(
      (await assertBackupArtifact(validArtifact, 1, { completionToken: COMPLETION_TOKEN })) > 0
    )
    await assert.rejects(
      assertBackupArtifact(trailingArtifact, 1, { completionToken: COMPLETION_TOKEN }),
      /failed gzip or pg_dump completion verification/
    )
  })
})

test('the executable uses the safe pipeline and CI runs the behavioral contract', async () => {
  const source = await readFile(new URL('./backup-to-r2.mjs', import.meta.url), 'utf8')
  const ci = await readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')

  assert.match(source, /execFileSync\(\s*'\/bin\/bash'/)
  assert.match(source, /'pipefail'/)
  assert.match(source, /\{ "\$@" && printf "%s" "\$sentinel"; \} \|/)
  assert.match(source, /--restrict-key=/)
  assert.match(source, /'completion-contract': ARENA_BACKUP_COMPLETION_CONTRACT/)
  assert.match(source, /'completion-token': completionToken/)
  assert.match(source, /new UploadClass\(/)
  assert.match(source, /new HeadObjectCommand\(/)
  assert.doesNotMatch(source, /PutObjectCommand/)
  assert.match(source, /cleanPostgresConnectionEnv\(/)
  assert.match(source, /parseBackupMode\(/)
  assert.doesNotMatch(source, /TRADER_TABLES|trader-tables/)
  assert.doesNotMatch(source, /execSync\(/)
  assert.doesNotMatch(source, /`\$\{pgDumpPath\}/)
  assert.match(ci, /node --test scripts\/maintenance\/backup-to-r2\.test\.mjs/)
})
