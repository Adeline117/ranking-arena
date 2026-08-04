import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { gzipSync } from 'node:zlib'

import {
  ARENA_BACKUP_COMPLETION_CONTRACT,
  arenaBackupCompletionSentinel,
  preparePostgresConnection,
  unverifiedBackupRecoveryMetadata,
} from './backup-restore-contract.mjs'
import { POSTGRES_CONNECTION_ENV_NAMES } from './postgres-cli-env.mjs'
import {
  assertRestoreTargetSafety,
  assertRestorableObject,
  CRITICAL_RESTORE_TABLES,
  downloadBackupObject,
  formatTargetIdentity,
  headBackup,
  isSamePostgresDatabase,
  isSameSupabaseProject,
  normalizePostgresIdentity,
  parseCriticalTableCounts,
  parseRestoreArgs,
  queryCriticalTableCounts,
  restoreSelectedBackup,
  runRestoreCli,
  runRestorePipeline,
  selectBackup,
} from './restore-from-r2.mjs'

const LEGACY_TOKEN = 'L'.repeat(63)
const ARENA_TOKEN = 'c'.repeat(64)

function pgDumpFixture({ token = LEGACY_TOKEN, body = 'SELECT 1;\n', arenaToken } = {}) {
  return (
    `--\n-- PostgreSQL database dump\n--\n\n\\restrict ${token}\n\n` +
    body +
    `--\n-- PostgreSQL database dump complete\n--\n\n\\unrestrict ${token}\n\n` +
    (arenaToken ? arenaBackupCompletionSentinel(arenaToken) : '')
  )
}

async function withTempDir(run) {
  const directory = await mkdtemp(join(tmpdir(), 'arena-restore-test-'))
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

function criticalCounts(overrides = {}) {
  const counts = {
    'arena.traders': '125',
    'arena.trader_stats': '124',
    'public.leaderboard_ranks': '120',
    ...overrides,
  }
  return CRITICAL_RESTORE_TABLES.map((table) => `${table}\t${counts[table]}`).join('\n') + '\n'
}

function completeSchemasObject(overrides = {}) {
  return {
    Key: 'db-backups/2026/07/arena-backup-20260726-schemas.sql.gz',
    Size: 5_000_000_000,
    ETag: '"complete-etag"',
    Metadata: {
      'backup-type': 'schemas:arena+public',
      tables: 'arena,public',
    },
    ...overrides,
  }
}

function arenaSchemasObject(overrides = {}) {
  return completeSchemasObject({
    Metadata: {
      'backup-type': 'schemas:arena+public',
      tables: 'arena,public',
      'completion-contract': ARENA_BACKUP_COMPLETION_CONTRACT,
      'completion-token': ARENA_TOKEN,
    },
    ...overrides,
  })
}

test('requires an explicit --key value and rejects ambiguous CLI combinations', () => {
  assert.deepEqual(parseRestoreArgs(['--key', 'db-backups/2026/07/backup.sql.gz']), {
    allowUnverifiedTarget: false,
    forceProd: false,
    key: 'db-backups/2026/07/backup.sql.gz',
    listOnly: false,
  })
  assert.throws(() => parseRestoreArgs(['--key']), /requires an R2 object key/)
  assert.equal(parseRestoreArgs(['--allow-unverified-target']).allowUnverifiedTarget, true)
  assert.throws(() => parseRestoreArgs(['--list', '--key', 'backup.sql.gz']), /cannot be used/)
  assert.throws(() => parseRestoreArgs(['--unknown']), /unknown argument/)
})

test('resolves an explicit key with HeadObject even when it is absent from a list page', async () => {
  const calls = []
  const expectedDate = new Date('2026-07-26T04:00:00.000Z')
  const s3 = {
    send: async (command) => {
      calls.push(command)
      return {
        ContentLength: 5_000_000_000,
        ETag: '"exact-etag"',
        LastModified: expectedDate,
        Metadata: { 'backup-type': 'schemas:arena+public', tables: 'arena,public' },
      }
    },
  }

  const selected = await headBackup(
    s3,
    'arena-backups',
    'db-backups/2026/07/arena-backup-20260726-schemas.sql.gz'
  )

  assert.equal(calls.length, 1)
  assert.equal(calls[0].constructor.name, 'HeadObjectCommand')
  assert.deepEqual(calls[0].input, {
    Bucket: 'arena-backups',
    Key: 'db-backups/2026/07/arena-backup-20260726-schemas.sql.gz',
  })
  assert.deepEqual(selected, {
    Key: 'db-backups/2026/07/arena-backup-20260726-schemas.sql.gz',
    Size: 5_000_000_000,
    LastModified: expectedDate,
    ETag: '"exact-etag"',
    Metadata: { 'backup-type': 'schemas:arena+public', tables: 'arena,public' },
  })
})

test('default newest selection is re-resolved through HeadObject metadata', async () => {
  const calls = []
  const key = 'db-backups/2026/07/arena-backup-20260728-schemas.sql.gz'
  const s3 = {
    send: async (command) => {
      calls.push(command)
      if (command.constructor.name === 'ListObjectsV2Command') {
        return {
          Contents: [{ Key: key, Size: 20, LastModified: new Date('2026-07-28T04:00:00Z') }],
        }
      }
      return {
        ContentLength: 20,
        ETag: '"head-etag"',
        Metadata: { 'backup-type': 'schemas:arena+public', tables: 'arena,public' },
      }
    },
  }

  const selected = await selectBackup(s3, 'arena-backups', null)
  assert.deepEqual(
    calls.map((command) => command.constructor.name),
    ['ListObjectsV2Command', 'HeadObjectCommand']
  )
  assert.equal(selected.Key, key)
  assert.equal(selected.Size, 20)
  assert.equal(selected.Metadata['backup-type'], 'schemas:arena+public')
})

test('rejects the 20-byte empty-gzip shape from object metadata before download', async () => {
  let downloads = 0
  let applies = 0
  let verifies = 0
  const selected = completeSchemasObject({
    Key: 'db-backups/2026/07/arena-backup-20260728-schemas.sql.gz',
    Size: 20,
  })

  assert.throws(() => assertRestorableObject(selected), /selected backup object is incomplete/)
  await assert.rejects(
    restoreSelectedBackup({
      selected,
      localPath: '/must-not-be-created.sql.gz',
      download: async () => {
        downloads += 1
      },
      apply: () => {
        applies += 1
      },
      verify: () => {
        verifies += 1
      },
    }),
    /selected backup object is incomplete/
  )
  assert.deepEqual({ downloads, applies, verifies }, { downloads: 0, applies: 0, verifies: 0 })
})

test('rejects a large trader-tables partial backup before download or apply', async () => {
  let downloads = 0
  const selected = completeSchemasObject({
    Key: 'db-backups/2026/07/arena-backup-20260728.sql.gz',
    Size: 5_000_000_000,
  })

  await assert.rejects(
    restoreSelectedBackup({
      selected,
      localPath: '/must-not-be-created.sql.gz',
      download: async () => {
        downloads += 1
      },
      apply: () => assert.fail('partial backup must not be applied'),
      verify: () => assert.fail('partial backup must not reach verification'),
    }),
    /not a complete schemas\/full backup/
  )
  assert.equal(downloads, 0)
})

test('requires HEAD metadata to prove arena+public completeness before download', async () => {
  const incompleteMetadata = [
    undefined,
    { 'backup-type': 'schemas:public', tables: 'public' },
    { 'backup-type': 'schemas:arena+public', tables: 'public' },
    { 'backup-type': 'full', tables: 'all' },
  ]

  for (const Metadata of incompleteMetadata) {
    let downloads = 0
    await assert.rejects(
      restoreSelectedBackup({
        selected: completeSchemasObject({ Metadata }),
        localPath: '/must-not-be-created.sql.gz',
        download: async () => {
          downloads += 1
        },
        apply: () => assert.fail('incomplete metadata must not reach psql'),
        verify: () => assert.fail('incomplete metadata must not reach verification'),
      }),
      /metadata/
    )
    assert.equal(downloads, 0)
  }

  assert.doesNotThrow(() =>
    assertRestorableObject(
      completeSchemasObject({
        Metadata: { 'Backup-Type': 'schemas:PUBLIC+Arena', TABLES: 'public,ARENA' },
      })
    )
  )
  assert.doesNotThrow(() =>
    assertRestorableObject(
      completeSchemasObject({
        Key: 'db-backups/2026/07/arena-backup-20260726-full.sql.gz',
        Metadata: { 'backup-type': 'FULL', tables: 'ALL' },
      })
    )
  )
  assert.doesNotThrow(() => assertRestorableObject(arenaSchemasObject()))
  assert.doesNotThrow(() =>
    assertRestorableObject(
      arenaSchemasObject({
        Key: `db-backups/2026/08/arena-backup-20260804T070809123Z-${'a'.repeat(32)}-schemas.sql.gz`,
        Metadata: {
          'backup-date': '2026-08-04T07:08:09.123Z',
          'backup-type': 'schemas:arena+public',
          tables: 'arena,public',
          'completion-contract': ARENA_BACKUP_COMPLETION_CONTRACT,
          'completion-token': ARENA_TOKEN,
          ...unverifiedBackupRecoveryMetadata('schemas'),
        },
      })
    )
  )
  assert.throws(
    () =>
      assertRestorableObject(
        arenaSchemasObject({
          Key: `db-backups/2026/08/arena-backup-20260804T070809123Z-${'a'.repeat(32)}-schemas.sql.gz`,
        })
      ),
    /filename and backup-date metadata do not match/
  )
  assert.throws(
    () =>
      assertRestorableObject(
        completeSchemasObject({
          Key: `db-backups/2026/08/arena-backup-20260804T070809123Z-${'a'.repeat(32)}-schemas.sql.gz`,
          Metadata: {
            'backup-date': '2026-08-04T07:08:09.123Z',
            'backup-type': 'schemas:arena+public',
            tables: 'arena,public',
          },
        })
      ),
    /missing completion metadata/
  )
  assert.throws(
    () =>
      assertRestorableObject(
        arenaSchemasObject({
          Key: `db-backups/2026/07/arena-backup-20260804T070809123Z-${'a'.repeat(32)}-schemas.sql.gz`,
        })
      ),
    /key path does not match/
  )
  assert.throws(
    () =>
      assertRestorableObject(
        arenaSchemasObject({
          Key: `db-backups/2026/08/arena-backup-20260804T070809123Z-${'a'.repeat(32)}-full.sql.gz`,
        })
      ),
    /full\/all completeness metadata/
  )
  assert.throws(
    () =>
      assertRestorableObject(
        arenaSchemasObject({
          Key: `db-backups/2026/08/arena-backup-20260804T070809123Z-short-schemas.sql.gz`,
        })
      ),
    /not a complete schemas\/full backup/
  )
  for (const Metadata of [
    {
      'backup-type': 'schemas:arena+public',
      tables: 'arena,public',
      'completion-contract': ARENA_BACKUP_COMPLETION_CONTRACT,
    },
    {
      'backup-type': 'schemas:arena+public',
      tables: 'arena,public',
      'completion-contract': 'wrong-contract',
      'completion-token': ARENA_TOKEN,
    },
  ]) {
    assert.throws(() => assertRestorableObject(completeSchemasObject({ Metadata })), /completion/)
  }
})

test('binds GET to the selected ETag and rejects response-size drift', async () => {
  await withTempDir(async (directory) => {
    const localPath = join(directory, 'backup.sql.gz')
    const body = Readable.from(Buffer.from('short body'))
    let command
    const s3 = {
      send: async (received) => {
        command = received
        return {
          Body: body,
          ContentLength: 9,
          ETag: '"selected-etag"',
          Metadata: selected.Metadata,
        }
      },
    }
    const selected = completeSchemasObject({
      Size: 10,
      ETag: '"selected-etag"',
    })

    await assert.rejects(
      downloadBackupObject({
        s3,
        bucket: 'arena-backups',
        selected,
        localPath,
        minimumBytes: 1,
      }),
      /size changed after selection/
    )
    assert.equal(command.constructor.name, 'GetObjectCommand')
    assert.deepEqual(command.input, {
      Bucket: 'arena-backups',
      Key: selected.Key,
      IfMatch: selected.ETag,
    })
    assert.equal(body.destroyed, true)
    await assert.rejects(stat(localPath), { code: 'ENOENT' })
  })
})

test('downloads the exact selected bytes before local integrity validation', async () => {
  await withTempDir(async (directory) => {
    const localPath = join(directory, 'backup.sql.gz')
    const artifact = gzipSync("SELECT 'restore';\n")
    const selected = completeSchemasObject({
      Size: artifact.length,
    })
    const s3 = {
      send: async () => ({
        Body: Readable.from(artifact),
        ContentLength: artifact.length,
        ETag: selected.ETag,
        Metadata: selected.Metadata,
      }),
    }

    await downloadBackupObject({
      s3,
      bucket: 'arena-backups',
      selected,
      localPath,
      minimumBytes: 1,
    })
    assert.deepEqual(await readFile(localPath), artifact)
    assert.equal((await stat(localPath)).mode & 0o777, 0o600)
  })
})

test('removes only its own private partial file when the R2 body fails', async () => {
  await withTempDir(async (directory) => {
    const localPath = join(directory, 'partial.sql.gz')
    const selected = completeSchemasObject({ Size: 20 })
    const body = Readable.from(
      (async function* () {
        yield Buffer.from('partial')
        throw new Error('simulated R2 stream failure')
      })()
    )

    await assert.rejects(
      downloadBackupObject({
        s3: {
          send: async () => ({
            Body: body,
            ContentLength: selected.Size,
            ETag: selected.ETag,
            Metadata: selected.Metadata,
          }),
        },
        bucket: 'arena-backups',
        selected,
        localPath,
        minimumBytes: 1,
      }),
      /simulated R2 stream failure/
    )
    assert.equal(body.destroyed, true)
    await assert.rejects(stat(localPath), { code: 'ENOENT' })
  })
})

test('never removes a pre-existing restore pathname when exclusive creation fails', async () => {
  await withTempDir(async (directory) => {
    const localPath = join(directory, 'existing.sql.gz')
    await writeFile(localPath, 'owner data', { mode: 0o600 })
    const selected = completeSchemasObject({ Size: 10 })
    const body = Readable.from('remote data')

    await assert.rejects(
      downloadBackupObject({
        s3: {
          send: async () => ({
            Body: body,
            ContentLength: selected.Size,
            ETag: selected.ETag,
            Metadata: selected.Metadata,
          }),
        },
        bucket: 'arena-backups',
        selected,
        localPath,
        minimumBytes: 1,
      }),
      /EEXIST/
    )
    assert.equal(body.destroyed, true)
    assert.equal(await readFile(localPath, 'utf8'), 'owner data')
  })
})

test('rejects changed GET identity and metadata before writing the body', async () => {
  await withTempDir(async (directory) => {
    const selected = completeSchemasObject()
    const responses = [
      {
        Body: Readable.from('body'),
        ContentLength: selected.Size,
        ETag: '"different-etag"',
        Metadata: selected.Metadata,
      },
      {
        Body: Readable.from('body'),
        ContentLength: selected.Size,
        ETag: selected.ETag,
        Metadata: { 'backup-type': 'schemas:public', tables: 'public' },
      },
    ]
    for (const [index, response] of responses.entries()) {
      const localPath = join(directory, `${index}.sql.gz`)
      await assert.rejects(
        downloadBackupObject({
          s3: { send: async () => response },
          bucket: 'arena-backups',
          selected,
          localPath,
          minimumBytes: 1,
        }),
        /ETag changed|failed completeness checks/
      )
      assert.equal(response.Body.destroyed, true)
      await assert.rejects(stat(localPath), { code: 'ENOENT' })
    }
  })
})

test('binds Arena completion metadata token between HEAD and GET', async () => {
  await withTempDir(async (directory) => {
    const selected = arenaSchemasObject()
    const body = Readable.from('body')
    const responseMetadata = {
      ...selected.Metadata,
      'completion-token': 'd'.repeat(64),
    }
    await assert.rejects(
      downloadBackupObject({
        s3: {
          send: async () => ({
            Body: body,
            ContentLength: selected.Size,
            ETag: selected.ETag,
            Metadata: responseMetadata,
          }),
        },
        bucket: 'arena-backups',
        selected,
        localPath: join(directory, 'must-not-write.sql.gz'),
        minimumBytes: 1,
      }),
      /completion token changed/
    )
    assert.equal(body.destroyed, true)
  })
})

test('rejects a corrupt downloaded gzip before psql or verification can run', async () => {
  await withTempDir(async (directory) => {
    const localPath = join(directory, 'backup.sql.gz')
    const corrupt = Buffer.from('not a gzip stream')
    let applies = 0
    let verifies = 0

    await assert.rejects(
      restoreSelectedBackup({
        selected: completeSchemasObject({
          Size: corrupt.length,
        }),
        localPath,
        minimumBytes: 1,
        download: () => writeFile(localPath, corrupt),
        apply: () => {
          applies += 1
        },
        verify: () => {
          verifies += 1
        },
      }),
      /failed gzip or pg_dump completion verification/
    )
    assert.deepEqual({ applies, verifies }, { applies: 0, verifies: 0 })
  })
})

test('rejects a large valid gzip with no exact pg_dump footer before applying SQL', async () => {
  await withTempDir(async (directory) => {
    const localPath = join(directory, 'semantic-half-dump.sql.gz')
    const incompleteDump =
      `--\n-- PostgreSQL database dump\n--\n\n\\restrict ${LEGACY_TOKEN}\n\n` +
      'x'.repeat(2 * 1024 * 1024) +
      '\n-- PostgreSQL database dump complete\n'
    const artifact = gzipSync(incompleteDump)
    let applies = 0
    let verifies = 0

    await assert.rejects(
      restoreSelectedBackup({
        selected: completeSchemasObject({ Size: artifact.length }),
        localPath,
        minimumBytes: artifact.length,
        download: () => writeFile(localPath, artifact),
        apply: () => {
          applies += 1
        },
        // Even pre-existing positive critical tables cannot turn a semantic
        // half-dump into a completed restore because verification is unreached.
        verify: () => {
          verifies += 1
          return criticalCounts()
        },
      }),
      /failed gzip or pg_dump completion verification/
    )
    assert.deepEqual({ applies, verifies }, { applies: 0, verifies: 0 })
  })
})

test('rejects a locally truncated object even when the remaining gzip is valid', async () => {
  await withTempDir(async (directory) => {
    const localPath = join(directory, 'backup.sql.gz')
    const artifact = gzipSync(pgDumpFixture())

    await assert.rejects(
      restoreSelectedBackup({
        selected: completeSchemasObject({
          Size: artifact.length + 1,
        }),
        localPath,
        minimumBytes: 1,
        download: () => writeFile(localPath, artifact),
        apply: () => assert.fail('psql must not run for a size mismatch'),
        verify: () => assert.fail('verification must not run for a size mismatch'),
      }),
      /does not match selected object/
    )
  })
})

test('pipefail exposes gunzip failure even when psql exits successfully', async () => {
  await withTempDir(async (directory) => {
    const gunzip = join(directory, 'gunzip')
    const psql = join(directory, 'psql')
    const bashEnv = join(directory, 'malicious-bash-env')
    const bashEnvMarker = join(directory, 'bash-env-sourced')
    await writeExecutable(gunzip, "#!/bin/sh\nprintf 'partial sql\\n'\nexit 42\n")
    await writeExecutable(psql, '#!/bin/sh\ncat >/dev/null\nexit 0\n')
    await writeFile(bashEnv, 'set +o pipefail\n: > "$BASH_ENV_MARKER"\n', 'utf8')

    await withProcessEnv(
      {
        BASH_ENV: bashEnv,
        ENV: bashEnv,
        BASH_ENV_MARKER: bashEnvMarker,
      },
      async () => {
        assert.throws(
          () =>
            runRestorePipeline({
              localGz: join(directory, 'unused.sql.gz'),
              gunzipPath: gunzip,
              psqlPath: psql,
              connectionUrl: 'postgresql://restore@db.example.com/app',
              password: undefined,
              timeoutMs: 5_000,
            }),
          (error) => error?.status === 42
        )
      }
    )
    await assert.rejects(stat(bashEnvMarker), { code: 'ENOENT' })
  })
})

test('psql failure makes the restore pipeline fail', async () => {
  await withTempDir(async (directory) => {
    const gunzip = join(directory, 'gunzip')
    const psql = join(directory, 'psql')
    await writeExecutable(gunzip, "#!/bin/sh\nprintf 'SELECT 1;\\n'\n")
    await writeExecutable(psql, '#!/bin/sh\ncat >/dev/null\nexit 37\n')

    assert.throws(
      () =>
        runRestorePipeline({
          localGz: join(directory, 'unused.sql.gz'),
          gunzipPath: gunzip,
          psqlPath: psql,
          connectionUrl: 'postgresql://restore@db.example.com/app',
          password: undefined,
          timeoutMs: 5_000,
        }),
      (error) => error?.status === 37
    )
  })
})

test('keeps authority and query passwords out of psql argv and logs', async () => {
  await withTempDir(async (directory) => {
    const gunzip = join(directory, 'gunzip')
    const psql = join(directory, 'psql')
    const argsLog = join(directory, 'args.log')
    const passwordLog = join(directory, 'password.log')
    const oldArgsLog = process.env.RESTORE_ARGS_LOG
    const oldPasswordLog = process.env.RESTORE_PASSWORD_LOG
    const oldPosixlyCorrect = process.env.POSIXLY_CORRECT
    process.env.RESTORE_ARGS_LOG = argsLog
    process.env.RESTORE_PASSWORD_LOG = passwordLog
    process.env.POSIXLY_CORRECT = '1'

    try {
      await writeExecutable(gunzip, "#!/bin/sh\nprintf 'SELECT 1;\\n'\n")
      await writeExecutable(
        psql,
        [
          '#!/bin/sh',
          'printf "%s\\n" "$@" > "$RESTORE_ARGS_LOG"',
          'printf "%s" "$PGPASSWORD" > "$RESTORE_PASSWORD_LOG"',
          'cat >/dev/null',
          '',
        ].join('\n')
      )
      const target =
        'postgresql://restore:authority-secret@DB.EXAMPLE.COM.:5432/app?sslmode=require&password=query%2Bsecret'
      const prepared = preparePostgresConnection(target, 'RESTORE_TARGET_URL')
      const identity = normalizePostgresIdentity(target, 'RESTORE_TARGET_URL')

      runRestorePipeline({
        localGz: join(directory, 'unused.sql.gz'),
        gunzipPath: gunzip,
        psqlPath: psql,
        ...prepared,
        timeoutMs: 5_000,
      })

      const argv = (await readFile(argsLog, 'utf8')).trim().split('\n')
      assert.deepEqual(argv, [
        '-X',
        '--no-password',
        '-v',
        'ON_ERROR_STOP=1',
        '--single-transaction',
        '--quiet',
        'postgresql://restore@DB.EXAMPLE.COM.:5432/app?sslmode=require',
      ])
      assert.doesNotMatch(
        argv.join('\n'),
        /authority-secret|query%2Bsecret|query\+secret|password=/
      )
      assert.equal(await readFile(passwordLog, 'utf8'), 'query+secret')
      assert.equal(formatTargetIdentity(identity), 'restore@db.example.com:5432/app')
      assert.doesNotMatch(formatTargetIdentity(identity), /secret|password|sslmode/)
    } finally {
      if (oldArgsLog === undefined) delete process.env.RESTORE_ARGS_LOG
      else process.env.RESTORE_ARGS_LOG = oldArgsLog
      if (oldPasswordLog === undefined) delete process.env.RESTORE_PASSWORD_LOG
      else process.env.RESTORE_PASSWORD_LOG = oldPasswordLog
      if (oldPosixlyCorrect === undefined) delete process.env.POSIXLY_CORRECT
      else process.env.POSIXLY_CORRECT = oldPosixlyCorrect
    }
  })
})

test('removes every ambient PG variable and parent credential from restore psql children', async () => {
  await withTempDir(async (directory) => {
    const gunzip = join(directory, 'gunzip')
    const psql = join(directory, 'psql')
    const pipelineEnvLog = join(directory, 'pipeline-env.log')
    const queryEnvLog = join(directory, 'query-env.log')
    await writeExecutable(gunzip, "#!/bin/sh\nprintf 'SELECT 1;\\n'\n")
    await writeExecutable(
      psql,
      [
        '#!/bin/sh',
        'printenv | sort > "$RESTORE_ENV_LOG"',
        'if [ "${RESTORE_EMIT_COUNTS-}" = 1 ]; then',
        "  printf 'arena.traders\\t5\\narena.trader_stats\\t4\\npublic.leaderboard_ranks\\t3\\n'",
        'else',
        '  cat >/dev/null',
        'fi',
        '',
      ].join('\n')
    )

    const poison = Object.fromEntries(
      POSTGRES_CONNECTION_ENV_NAMES.map((name) => [name, `ambient-${name}`])
    )
    await withProcessEnv(
      {
        ...poison,
        PG_FUTURE_CONNECTION_OVERRIDE: 'ambient-future-pg',
        DATABASE_URL: 'postgresql://production:parent-secret@prod.invalid/app',
        RESTORE_TARGET_URL: 'postgresql://restore:target-secret@target.invalid/app',
        R2_ACCESS_KEY_ID: 'parent-r2-access',
        R2_SECRET_ACCESS_KEY: 'parent-r2-secret',
        POSIXLY_CORRECT: '1',
        'BASH_FUNC_printf%%': '() { :; }',
        RESTORE_ENV_LOG: pipelineEnvLog,
        RESTORE_EMIT_COUNTS: '0',
      },
      async () => {
        runRestorePipeline({
          localGz: join(directory, 'unused.sql.gz'),
          gunzipPath: gunzip,
          psqlPath: psql,
          connectionUrl: 'postgresql://restore@db.example.com/app',
          password: 'parsed-target-password',
          timeoutMs: 5_000,
        })

        const pipelineEnv = await readFile(pipelineEnvLog, 'utf8')
        assert.match(pipelineEnv, /^PGPASSWORD=parsed-target-password$/m)
        for (const name of POSTGRES_CONNECTION_ENV_NAMES) {
          if (name !== 'PGPASSWORD') assert.doesNotMatch(pipelineEnv, new RegExp(`^${name}=`, 'm'))
        }
        assert.doesNotMatch(
          pipelineEnv,
          /PG_FUTURE_CONNECTION_OVERRIDE|POSIXLY_CORRECT|BASH_FUNC_|parent-secret|target-secret|parent-r2/
        )

        process.env.RESTORE_ENV_LOG = queryEnvLog
        process.env.RESTORE_EMIT_COUNTS = '1'
        const output = queryCriticalTableCounts({
          psqlPath: psql,
          connectionUrl: 'postgresql://restore@db.example.com/app',
          password: undefined,
          timeoutMs: 5_000,
        })
        assert.equal(parseCriticalTableCounts(output)['arena.traders'], 5n)
        const queryEnv = await readFile(queryEnvLog, 'utf8')
        assert.doesNotMatch(queryEnv, /^PG[A-Z0-9_]*=/m)
        assert.doesNotMatch(queryEnv, /parent-secret|target-secret|parent-r2/)
      }
    )
  })
})

test('normalizes equivalent production identities, including query overrides', () => {
  const production = normalizePostgresIdentity(
    'postgresql://restore:prod-secret@db.example.com/app?connect_timeout=5',
    'DATABASE_URL'
  )
  const equivalent = normalizePostgresIdentity(
    'postgres://restore:other-secret@DB.EXAMPLE.COM.:5432/app?sslmode=require',
    'RESTORE_TARGET_URL'
  )
  const queryOverride = normalizePostgresIdentity(
    'postgres://decoy@localhost/decoy?host=DB.EXAMPLE.COM.&port=05432&dbname=app&user=restore&password=hidden',
    'RESTORE_TARGET_URL'
  )
  const differentRole = normalizePostgresIdentity(
    'postgres://another_role@db.example.com:5432/app',
    'RESTORE_TARGET_URL'
  )
  const differentDatabase = normalizePostgresIdentity(
    'postgres://restore@db.example.com:5432/scratch',
    'RESTORE_TARGET_URL'
  )
  const ipv6Authority = normalizePostgresIdentity(
    'postgres://restore@[0:0:0:0:0:0:0:1]:5432/app',
    'DATABASE_URL'
  )
  const ipv6QueryOverride = normalizePostgresIdentity(
    'postgres://another_role@decoy.example.com/app?host=::1',
    'RESTORE_TARGET_URL'
  )

  assert.equal(isSamePostgresDatabase(production, equivalent), true)
  assert.equal(isSamePostgresDatabase(production, queryOverride), true)
  assert.equal(isSamePostgresDatabase(production, differentRole), true)
  assert.equal(isSamePostgresDatabase(production, differentDatabase), false)
  assert.equal(ipv6Authority.host, '::1')
  assert.equal(isSamePostgresDatabase(ipv6Authority, ipv6QueryOverride), true)
  assert.throws(
    () =>
      normalizePostgresIdentity(
        'postgres://restore@db.example.com/app#password=hidden',
        'RESTORE_TARGET_URL'
      ),
    /fragments are unsupported/
  )
  assert.throws(
    () =>
      normalizePostgresIdentity(
        'postgres://restore@db.example.com/app?service=prod',
        'RESTORE_TARGET_URL'
      ),
    /unsupported for restore safety/
  )
  assert.throws(
    () =>
      normalizePostgresIdentity(
        'postgres://restore@db.example.com/app?host=a,b',
        'RESTORE_TARGET_URL'
      ),
    /exactly one PostgreSQL host/
  )
})

test('binds Supabase direct and pooler identities to the same production project', () => {
  const projectRef = 'iknktzifjdyujdccyhsv'
  const productionDirect = normalizePostgresIdentity(
    `postgresql://postgres:secret@db.${projectRef}.supabase.co:5432/postgres`,
    'DATABASE_URL'
  )
  const sameProjectPooler = normalizePostgresIdentity(
    `postgresql://postgres.${projectRef}:other@aws-0-us-west-2.pooler.supabase.com:6543/otherdb`,
    'RESTORE_TARGET_URL'
  )
  const otherProjectPooler = normalizePostgresIdentity(
    'postgresql://postgres.aaaaaaaaaaaaaaaaaaaa:other@aws-0-us-west-2.pooler.supabase.com:6543/postgres',
    'RESTORE_TARGET_URL'
  )

  assert.equal(isSamePostgresDatabase(productionDirect, sameProjectPooler), false)
  assert.equal(isSameSupabaseProject(productionDirect, sameProjectPooler), true)
  assert.equal(isSameSupabaseProject(productionDirect, otherProjectPooler), false)
  assert.throws(
    () =>
      assertRestoreTargetSafety({
        targetIdentity: sameProjectPooler,
        productionIdentity: productionDirect,
        forceProd: false,
        allowUnverifiedTarget: false,
      }),
    /production database or Supabase project/
  )
})

test('the fixed production project cannot be bypassed by a missing or wrong baseline', () => {
  const targetIdentity = normalizePostgresIdentity(
    'postgresql://postgres@db.iknktzifjdyujdccyhsv.supabase.co:5432/postgres',
    'RESTORE_TARGET_URL'
  )
  const wrongProductionIdentity = normalizePostgresIdentity(
    'postgresql://postgres@db.aaaaaaaaaaaaaaaaaaaa.supabase.co:5432/postgres',
    'DATABASE_URL'
  )

  for (const productionIdentity of [null, wrongProductionIdentity]) {
    assert.throws(
      () =>
        assertRestoreTargetSafety({
          targetIdentity,
          productionIdentity,
          forceProd: false,
          allowUnverifiedTarget: true,
        }),
      /production database or Supabase project/
    )
  }
  assert.throws(
    () =>
      assertRestoreTargetSafety({
        targetIdentity,
        productionIdentity: null,
        forceProd: true,
        allowUnverifiedTarget: false,
      }),
    /--allow-unverified-target/
  )
  assert.doesNotThrow(() =>
    assertRestoreTargetSafety({
      targetIdentity,
      productionIdentity: null,
      forceProd: true,
      allowUnverifiedTarget: true,
    })
  )
})

test('requires a distinct explicit confirmation when production identity is unavailable', () => {
  const targetIdentity = normalizePostgresIdentity(
    'postgresql://restore@isolated.example.com/scratch',
    'RESTORE_TARGET_URL'
  )

  for (const forceProd of [false, true]) {
    assert.throws(
      () =>
        assertRestoreTargetSafety({
          targetIdentity,
          productionIdentity: null,
          forceProd,
          allowUnverifiedTarget: false,
        }),
      /--allow-unverified-target/
    )
  }
  assert.doesNotThrow(() =>
    assertRestoreTargetSafety({
      targetIdentity,
      productionIdentity: null,
      forceProd: false,
      allowUnverifiedTarget: true,
    })
  )
})

test('the CLI refuses the same production database across password, port, and role spellings', async () => {
  await assert.rejects(
    runRestoreCli({
      argv: [],
      env: {
        R2_ACCOUNT_ID: 'test-account',
        R2_ACCESS_KEY_ID: 'test-access-key',
        R2_SECRET_ACCESS_KEY: 'test-secret-key',
        DATABASE_URL: 'postgresql://production_role:old-secret@db.example.com/app',
        RESTORE_TARGET_URL:
          'postgres://restore_role:new-secret@DB.EXAMPLE.COM.:5432/app?sslmode=require',
      },
    }),
    /identifies the production database/
  )
})

test('the CLI fails before R2 access when no production identity baseline is available', async () => {
  const env = {
    R2_ACCOUNT_ID: 'test-account',
    R2_ACCESS_KEY_ID: 'test-access-key',
    R2_SECRET_ACCESS_KEY: 'test-secret-key',
    RESTORE_TARGET_URL: 'postgresql://restore@isolated.example.com/scratch',
  }
  for (const argv of [[], ['--force-prod']]) {
    await assert.rejects(runRestoreCli({ argv, env }), /--allow-unverified-target/)
  }
})

test('the CLI refuses legacy plain artifact apply even for an isolated verified target', async () => {
  await assert.rejects(
    runRestoreCli({
      argv: [],
      env: {
        DATABASE_URL: 'postgresql://production@db.production.example.com/app',
        RESTORE_TARGET_URL: 'postgresql://restore@isolated.example.com/scratch',
      },
    }),
    /AUTOMATED RESTORE DISABLED.*target-model=unproven.*managed auth/
  )
})

test('verification accepts exactly one positive finite count for every critical table', () => {
  assert.deepEqual(parseCriticalTableCounts(criticalCounts()), {
    'arena.traders': 125n,
    'arena.trader_stats': 124n,
    'public.leaderboard_ranks': 120n,
  })

  for (const invalidCount of ['0', 'NaN', 'Infinity', '-1', '1.5', '9223372036854775808']) {
    assert.throws(
      () => parseCriticalTableCounts(criticalCounts({ 'arena.traders': invalidCount })),
      /verification/
    )
  }
  assert.throws(
    () => parseCriticalTableCounts('arena.traders\t1\narena.trader_stats\t1\n'),
    /missing public\.leaderboard_ranks/
  )
  assert.throws(
    () => parseCriticalTableCounts(`${criticalCounts()}arena.traders\t1\n`),
    /duplicate count/
  )
})

test('verification query uses sanitized argv, PGPASSWORD, and strict psql flags', async () => {
  await withTempDir(async (directory) => {
    const psql = join(directory, 'psql')
    const argsLog = join(directory, 'verify-args.log')
    const passwordLog = join(directory, 'verify-password.log')
    const oldArgsLog = process.env.RESTORE_ARGS_LOG
    const oldPasswordLog = process.env.RESTORE_PASSWORD_LOG
    const oldPosixlyCorrect = process.env.POSIXLY_CORRECT
    process.env.RESTORE_ARGS_LOG = argsLog
    process.env.RESTORE_PASSWORD_LOG = passwordLog
    process.env.POSIXLY_CORRECT = '1'

    try {
      await writeExecutable(
        psql,
        [
          '#!/bin/sh',
          'printf "%s\\n" "$@" > "$RESTORE_ARGS_LOG"',
          'printf "%s" "$PGPASSWORD" > "$RESTORE_PASSWORD_LOG"',
          "printf 'arena.traders\\t5\\narena.trader_stats\\t4\\npublic.leaderboard_ranks\\t3\\n'",
          '',
        ].join('\n')
      )
      const prepared = preparePostgresConnection(
        'postgresql://restore:secret@db.example.com/app?password=query-secret&sslmode=require',
        'RESTORE_TARGET_URL'
      )
      const output = queryCriticalTableCounts({
        psqlPath: psql,
        ...prepared,
        timeoutMs: 5_000,
      })

      assert.deepEqual(parseCriticalTableCounts(output), {
        'arena.traders': 5n,
        'arena.trader_stats': 4n,
        'public.leaderboard_ranks': 3n,
      })
      const argv = (await readFile(argsLog, 'utf8')).trim().split('\n')
      assert.equal(argv[0], '-X')
      assert.equal(argv[1], '--no-password')
      assert.equal(argv[2], '-v')
      assert.equal(argv[3], 'ON_ERROR_STOP=1')
      assert.equal(argv.at(-1), 'postgresql://restore@db.example.com/app?sslmode=require')
      assert.match(argv.join('\n'), /arena\.traders/)
      assert.doesNotMatch(argv.join('\n'), /secret|password=/)
      assert.equal(await readFile(passwordLog, 'utf8'), 'query-secret')
    } finally {
      if (oldArgsLog === undefined) delete process.env.RESTORE_ARGS_LOG
      else process.env.RESTORE_ARGS_LOG = oldArgsLog
      if (oldPasswordLog === undefined) delete process.env.RESTORE_PASSWORD_LOG
      else process.env.RESTORE_PASSWORD_LOG = oldPasswordLog
      if (oldPosixlyCorrect === undefined) delete process.env.POSIXLY_CORRECT
      else process.env.POSIXLY_CORRECT = oldPosixlyCorrect
    }
  })
})

test('orchestration reaches verified completion only after download and apply', async () => {
  await withTempDir(async (directory) => {
    const localPath = join(directory, 'backup.sql.gz')
    const artifact = gzipSync(pgDumpFixture())
    const events = []
    const counts = await restoreSelectedBackup({
      selected: completeSchemasObject({
        Size: artifact.length,
      }),
      localPath,
      minimumBytes: 1,
      download: async () => {
        events.push('download')
        await writeFile(localPath, artifact)
      },
      apply: () => events.push('apply'),
      verify: () => {
        events.push('verify')
        return criticalCounts()
      },
    })

    assert.deepEqual(events, ['download', 'apply', 'verify'])
    assert.equal(counts['arena.traders'], 125n)
  })
})

test('new Arena completion metadata binds the exact artifact EOF before apply', async () => {
  await withTempDir(async (directory) => {
    const localPath = join(directory, 'arena-backup.sql.gz')
    const artifact = gzipSync(pgDumpFixture({ token: ARENA_TOKEN, arenaToken: ARENA_TOKEN }))
    const events = []
    await restoreSelectedBackup({
      selected: arenaSchemasObject({ Size: artifact.length }),
      localPath,
      minimumBytes: 1,
      download: () => writeFile(localPath, artifact),
      apply: () => events.push('apply'),
      verify: () => {
        events.push('verify')
        return criticalCounts()
      },
    })
    assert.deepEqual(events, ['apply', 'verify'])
  })
})

test('the executable is fail-closed and its real behavior contract runs in CI', async () => {
  const source = await readFile(new URL('./restore-from-r2.mjs', import.meta.url), 'utf8')
  const ci = await readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')

  assert.match(source, /HeadObjectCommand/)
  assert.match(source, /'pipefail'/)
  assert.match(source, /assertBackupArtifact\(localPath, minimumBytes, \{ completionToken \}\)/)
  assert.match(source, /parseCriticalTableCounts\(await verify\(\)\)/)
  assert.doesNotMatch(source, /execSync\(/)
  assert.doesNotMatch(source, /`[^`]*\$\{TARGET\}/)
  assert.match(source, /AUTOMATED RESTORE DISABLED/)
  assert.doesNotMatch(source, /\[restore\] DONE/)
  assert.match(ci, /node --test scripts\/maintenance\/restore-from-r2\.test\.mjs/)
})
