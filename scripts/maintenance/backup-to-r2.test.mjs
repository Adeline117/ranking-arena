import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  assertBackupArtifact,
  COMPLETE_BACKUP_MIN_BYTES,
  preparePgDumpConnection,
  produceAndCommitBackup,
  runPgDumpPipeline,
} from './backup-to-r2.mjs'

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

test('leaves passwordless URLs and inherited libpq authentication unchanged', () => {
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
    let uploads = 0
    let prunes = 0
    await writeExecutable(pgDump, "#!/bin/sh\nprintf 'partial sql before failure\\n'\nexit 42\n")

    await assert.rejects(
      produceAndCommitBackup({
        produce: () =>
          runPgDumpPipeline({
            pgDumpPath: pgDump,
            connectionUrl: 'postgresql://backup@db.example.com/app',
            password: 'test-password',
            pgDumpArgs: ['--no-owner'],
            outputPath: output,
            timeoutMs: 5_000,
          }),
        localPath: output,
        minimumBytes: 1,
        upload: async () => {
          uploads += 1
        },
        prune: async () => {
          prunes += 1
        },
      }),
      (error) => error?.status === 42
    )

    // gzip still emitted an artifact, proving the regression exercises the
    // exact false-success shape. Neither remote side effect was reached.
    assert.ok((await stat(output)).size > 0)
    assert.equal(uploads, 0)
    assert.equal(prunes, 0)
  })
})

test('passes dynamic pg_dump values as literal argv and the password only through env', async () => {
  await withTempDir(async (directory) => {
    const pgDump = join(directory, 'fake-pg-dump')
    const output = join(directory, 'success.sql.gz')
    const argsLog = join(directory, 'args.log')
    const passwordLog = join(directory, 'password.log')
    const injectedPath = join(directory, 'must-not-exist')
    const originalArgsLog = process.env.FAKE_ARGS_LOG
    const originalPasswordLog = process.env.FAKE_PASSWORD_LOG
    process.env.FAKE_ARGS_LOG = argsLog
    process.env.FAKE_PASSWORD_LOG = passwordLog

    try {
      await writeExecutable(
        pgDump,
        [
          '#!/bin/sh',
          'printf "%s\\n" "$@" > "$FAKE_ARGS_LOG"',
          'printf "%s" "$PGPASSWORD" > "$FAKE_PASSWORD_LOG"',
          "printf 'CREATE TABLE arena.traders (id bigint);\\n'",
          '',
        ].join('\n')
      )
      const literalSchema = `arena; touch ${injectedPath}`
      runPgDumpPipeline({
        pgDumpPath: pgDump,
        connectionUrl: 'postgresql://backup@db.example.com/app?sslmode=require',
        password: 'p@ss:word',
        pgDumpArgs: ['-n', literalSchema, '--no-owner'],
        outputPath: output,
        timeoutMs: 5_000,
      })

      assert.deepEqual((await readFile(argsLog, 'utf8')).trim().split('\n'), [
        'postgresql://backup@db.example.com/app?sslmode=require',
        '-n',
        literalSchema,
        '--no-owner',
      ])
      assert.equal(await readFile(passwordLog, 'utf8'), 'p@ss:word')
      await assert.rejects(stat(injectedPath), { code: 'ENOENT' })
      assert.ok(assertBackupArtifact(output, 1) > 0)
    } finally {
      if (originalArgsLog === undefined) delete process.env.FAKE_ARGS_LOG
      else process.env.FAKE_ARGS_LOG = originalArgsLog
      if (originalPasswordLog === undefined) delete process.env.FAKE_PASSWORD_LOG
      else process.env.FAKE_PASSWORD_LOG = originalPasswordLog
    }
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
    await writeExecutable(pgDump, "#!/bin/sh\nprintf 'SELECT 1;\\n'\n")
    await assert.rejects(
      produceAndCommitBackup({
        produce: () =>
          runPgDumpPipeline({
            pgDumpPath: pgDump,
            connectionUrl: 'postgresql://backup@db.example.com/app',
            password: undefined,
            pgDumpArgs: [],
            outputPath: output,
            timeoutMs: 5_000,
          }),
        localPath: output,
        minimumBytes: COMPLETE_BACKUP_MIN_BYTES,
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
        upload,
        prune,
      }),
      /failed gzip integrity verification/
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
    await writeExecutable(pgDump, "#!/bin/sh\nprintf 'SELECT 1;\\n'\n")

    const size = await produceAndCommitBackup({
      produce: () =>
        runPgDumpPipeline({
          pgDumpPath: pgDump,
          connectionUrl: 'postgresql://backup@db.example.com/app',
          password: undefined,
          pgDumpArgs: [],
          outputPath: output,
          timeoutMs: 5_000,
        }),
      localPath: output,
      minimumBytes: 1,
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

test('the executable uses the safe pipeline and CI runs the behavioral contract', async () => {
  const source = await readFile(new URL('./backup-to-r2.mjs', import.meta.url), 'utf8')
  const ci = await readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')

  assert.match(source, /execFileSync\(\s*'\/bin\/bash'/)
  assert.match(source, /'pipefail'/)
  assert.match(source, /\{ \.\.\.process\.env, PGPASSWORD: password \}/)
  assert.doesNotMatch(source, /execSync\(/)
  assert.doesNotMatch(source, /`\$\{pgDumpPath\}/)
  assert.match(ci, /node --test scripts\/maintenance\/backup-to-r2\.test\.mjs/)
})
