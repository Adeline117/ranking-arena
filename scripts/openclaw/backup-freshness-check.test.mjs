import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  ARENA_BACKUP_COMPLETION_CONTRACT,
  COMPLETE_BACKUP_MIN_BYTES,
  unverifiedBackupRecoveryMetadata,
} from '../maintenance/backup-restore-contract.mjs'
import {
  assertFreshBackupHead,
  checkBackupFreshness,
  R2_REQUEST_TIMEOUT_MS,
  runBackupFreshnessCli,
  sendTelegramAlert,
  TELEGRAM_REQUEST_TIMEOUT_MS,
} from './backup-freshness-check.mjs'

const COMPLETION_TOKEN = 'a'.repeat(64)
const BUCKET = 'arena-backups'
const NOW = new Date('2026-08-04T12:00:00.000Z')

function immutableKey({
  timestamp = '20260804T100000000Z',
  runId = 'b'.repeat(32),
  mode = 'schemas',
} = {}) {
  return `db-backups/2026/08/arena-backup-${timestamp}-${runId}-${mode}.sql.gz`
}

function completeMetadata({ backupDate = '2026-08-04T10:00:00.000Z', mode = 'schemas' } = {}) {
  return {
    'backup-date': backupDate,
    'backup-type': mode === 'full' ? 'full' : 'schemas:arena+public',
    tables: mode === 'full' ? 'all' : 'arena,public',
    'completion-contract': ARENA_BACKUP_COMPLETION_CONTRACT,
    'completion-token': COMPLETION_TOKEN,
    ...unverifiedBackupRecoveryMetadata(mode),
  }
}

function completeHead({ mode = 'schemas', Metadata, ...overrides } = {}) {
  return {
    ContentLength: COMPLETE_BACKUP_MIN_BYTES + 123,
    ContentType: 'application/gzip',
    ETag: '"complete-etag"',
    Metadata: Metadata ?? completeMetadata({ mode }),
    ...overrides,
  }
}

function fakeS3(handler) {
  const calls = []
  const requestOptions = []
  return {
    calls,
    requestOptions,
    send: async (command, options) => {
      calls.push(command)
      requestOptions.push(options)
      return handler(command, calls.length - 1, options)
    },
  }
}

test('paginates, ignores arbitrary gzip and old no-suffix partial, then HEADs only the newest complete key', async () => {
  const legacyKey = 'db-backups/2026/08/arena-backup-20260804-schemas.sql.gz'
  const selectedKey = immutableKey({ mode: 'full' })
  const s3 = fakeS3((command) => {
    if (command.constructor.name === 'ListObjectsV2Command') {
      if (!command.input.ContinuationToken) {
        return {
          IsTruncated: true,
          NextContinuationToken: 'page-2',
          Contents: [
            {
              Key: 'db-backups/2026/08/manual-copy.sql.gz',
              LastModified: new Date('2026-08-04T11:59:00Z'),
              Size: 9_000_000_000,
            },
            {
              Key: 'db-backups/2026/08/arena-backup-20260804.sql.gz',
              LastModified: new Date('2026-08-04T11:58:00Z'),
              Size: 9_000_000_000,
            },
            {
              Key: legacyKey,
              LastModified: new Date('2026-08-04T10:30:00Z'),
              Size: 20,
            },
          ],
        }
      }
      assert.equal(command.input.ContinuationToken, 'page-2')
      return {
        IsTruncated: false,
        Contents: [
          {
            Key: selectedKey,
            LastModified: new Date('2026-08-04T11:00:00Z'),
            // LIST size must neither prove nor disprove completeness.
            Size: 20,
          },
        ],
      }
    }

    assert.equal(command.constructor.name, 'HeadObjectCommand')
    assert.deepEqual(command.input, { Bucket: BUCKET, Key: selectedKey })
    return completeHead({ mode: 'full' })
  })

  const result = await checkBackupFreshness({ s3, bucket: BUCKET, now: NOW })

  assert.equal(result.Key, selectedKey)
  assert.equal(result.mode, 'full')
  assert.equal(result.ageHours, 2)
  assert.deepEqual(
    s3.calls.map((command) => command.constructor.name),
    ['ListObjectsV2Command', 'ListObjectsV2Command', 'HeadObjectCommand']
  )
  assert.deepEqual(s3.calls[0].input, {
    Bucket: BUCKET,
    Prefix: 'db-backups/',
    ContinuationToken: undefined,
  })
  assert.equal(R2_REQUEST_TIMEOUT_MS, 20_000)
  assert.equal(s3.requestOptions.length, 3)
  for (const options of s3.requestOptions) {
    assert.ok(options.abortSignal instanceof AbortSignal)
    assert.equal(options.abortSignal.aborted, false)
  }
})

test('retains legacy complete schemas filename compatibility with current completion evidence', async () => {
  const key = 'db-backups/2026/08/arena-backup-20260804-schemas.sql.gz'
  const s3 = fakeS3((command) => {
    if (command.constructor.name === 'ListObjectsV2Command') {
      return {
        Contents: [{ Key: key, LastModified: new Date('2026-08-04T10:10:00Z') }],
      }
    }
    return completeHead({
      Metadata: {
        ...completeMetadata(),
        'backup-type': 'schemas:PUBLIC+Arena',
        tables: 'arena,PUBLIC',
      },
    })
  })

  const result = await checkBackupFreshness({ s3, bucket: BUCKET, now: NOW })
  assert.equal(result.Key, key)
  assert.equal(result.mode, 'schemas')
})

test('does not count an old no-suffix partial as an available complete backup', async () => {
  const s3 = fakeS3((command) => {
    assert.equal(command.constructor.name, 'ListObjectsV2Command')
    return {
      Contents: [
        {
          Key: 'db-backups/2026/08/arena-backup-20260804.sql.gz',
          LastModified: new Date('2026-08-04T11:00:00Z'),
          Size: 9_000_000_000,
        },
      ],
    }
  })

  await assert.rejects(
    checkBackupFreshness({ s3, bucket: BUCKET, now: NOW }),
    /no shared-contract schemas\/full backup/
  )
  assert.equal(s3.calls.length, 1)
})

test('does not count a contract filename stored under a mismatched year/month path', async () => {
  const s3 = fakeS3(() => ({
    Contents: [
      {
        Key: `db-backups/2026/07/arena-backup-20260804T100000000Z-${'b'.repeat(32)}-schemas.sql.gz`,
        LastModified: new Date('2026-08-04T11:00:00Z'),
      },
    ],
  }))

  await assert.rejects(
    checkBackupFreshness({ s3, bucket: BUCKET, now: NOW }),
    /no shared-contract schemas\/full backup/
  )
  assert.equal(s3.calls.length, 1)
})

test('fails on the newest complete candidate HEAD instead of falling back to an older green object', async () => {
  const olderKey = immutableKey({ timestamp: '20260804T090000000Z', runId: 'c'.repeat(32) })
  const newerKey = immutableKey({ timestamp: '20260804T100000000Z', runId: 'd'.repeat(32) })
  const s3 = fakeS3((command) => {
    if (command.constructor.name === 'ListObjectsV2Command') {
      return {
        Contents: [
          { Key: olderKey, LastModified: new Date('2026-08-04T09:10:00Z') },
          { Key: newerKey, LastModified: new Date('2026-08-04T10:10:00Z') },
        ],
      }
    }
    assert.equal(command.input.Key, newerKey)
    return completeHead({
      Metadata: {
        'backup-date': '2026-08-04T10:00:00.000Z',
        'backup-type': 'schemas:arena+public',
        tables: 'arena,public',
      },
    })
  })

  await assert.rejects(
    checkBackupFreshness({ s3, bucket: BUCKET, now: NOW }),
    /immutable backup is missing completion metadata/
  )
  assert.equal(
    s3.calls.filter((command) => command.constructor.name === 'HeadObjectCommand').length,
    1
  )
})

test('HEAD contract rejects unsafe size, weak identity, invalid completion, mode drift, and date drift', async (t) => {
  const fullKey = immutableKey({ mode: 'full' })
  const valid = completeHead({ mode: 'full' })
  const cases = [
    [
      'non-finite size',
      { ...valid, ContentLength: Number.POSITIVE_INFINITY },
      /selected backup object is incomplete/,
    ],
    ['fractional size', { ...valid, ContentLength: 1.5 }, /selected backup object is incomplete/],
    [
      'unsafe size',
      { ...valid, ContentLength: Number.MAX_SAFE_INTEGER + 1 },
      /selected backup object is incomplete/,
    ],
    [
      'undersized object',
      { ...valid, ContentLength: COMPLETE_BACKUP_MIN_BYTES - 1 },
      /selected backup object is incomplete/,
    ],
    ['missing ETag', { ...valid, ETag: '  ' }, /missing an ETag/],
    [
      'wrong content type',
      { ...valid, ContentType: 'application/octet-stream' },
      /ContentType must be application\/gzip/,
    ],
    [
      'missing completion evidence',
      {
        ...valid,
        Metadata: {
          'backup-date': '2026-08-04T10:00:00.000Z',
          'backup-type': 'full',
          tables: 'all',
        },
      },
      /immutable backup is missing completion metadata/,
    ],
    [
      'invalid completion contract',
      {
        ...valid,
        Metadata: { ...valid.Metadata, 'completion-contract': 'wrong-contract' },
      },
      /backup completion metadata is incomplete or invalid/,
    ],
    [
      'filename and metadata mode disagree',
      { ...valid, Metadata: completeMetadata({ mode: 'schemas' }) },
      /full\/all completeness metadata/,
    ],
    [
      'unparseable backup date',
      { ...valid, Metadata: { ...valid.Metadata, 'backup-date': 'not-a-date' } },
      /immutable backup filename and backup-date metadata do not match/,
    ],
    [
      'key and metadata UTC dates disagree',
      {
        ...valid,
        Metadata: { ...valid.Metadata, 'backup-date': '2026-08-03T23:59:59.000Z' },
      },
      /immutable backup filename and backup-date metadata do not match/,
    ],
    [
      'same UTC date but timestamp differs from immutable filename',
      {
        ...valid,
        Metadata: { ...valid.Metadata, 'backup-date': '2026-08-04T10:00:00.001Z' },
      },
      /immutable backup filename and backup-date metadata do not match/,
    ],
    [
      'missing recovery scope proof',
      {
        ...valid,
        Metadata: { ...valid.Metadata, 'recovery-scope': undefined },
      },
      /immutable backup recovery metadata is invalid: recovery-scope/,
    ],
  ]

  for (const [name, head, expected] of cases) {
    await t.test(name, () => {
      assert.throws(() => assertFreshBackupHead(fullKey, head), expected)
    })
  }
})

test('schemas HEAD metadata requires matching complete arena+public schema sets', () => {
  const key = immutableKey()
  assert.doesNotThrow(() =>
    assertFreshBackupHead(
      key,
      completeHead({
        Metadata: {
          ...completeMetadata(),
          'backup-type': 'schemas:Public+extensions+ARENA',
          tables: 'extensions,arena,public',
        },
      })
    )
  )
  assert.throws(
    () =>
      assertFreshBackupHead(
        key,
        completeHead({
          Metadata: {
            ...completeMetadata(),
            'backup-type': 'schemas:arena+public+extensions',
            tables: 'arena,public',
          },
        })
      ),
    /same set including arena and public/
  )
})

test('uses backup-date for age so re-uploading an old artifact cannot make it fresh', async () => {
  const key = immutableKey({ timestamp: '20260801T100000000Z' })
  const s3 = fakeS3((command) => {
    if (command.constructor.name === 'ListObjectsV2Command') {
      return {
        Contents: [
          {
            Key: key,
            // A copy/re-upload looks recent in LIST but its producer date is old.
            LastModified: new Date('2026-08-04T11:59:00Z'),
            Size: 9_000_000_000,
          },
        ],
      }
    }
    return completeHead({
      LastModified: new Date('2026-08-04T11:59:00Z'),
      Metadata: completeMetadata({ backupDate: '2026-08-01T10:00:00.000Z' }),
    })
  })

  await assert.rejects(
    checkBackupFreshness({ s3, bucket: BUCKET, now: NOW }),
    /is 74\.0h old > 26h/
  )
})

test('Telegram webhook non-2xx rejects and makes the CLI return a sentinel-failure code', async () => {
  const env = {
    R2_ACCOUNT_ID: 'account',
    R2_ACCESS_KEY_ID: 'access',
    R2_SECRET_ACCESS_KEY: 'secret',
    TELEGRAM_BOT_TOKEN: 'bot-token',
    TELEGRAM_ALERT_CHAT_ID: 'chat-id',
  }
  let requests = 0
  const fetchImpl = async () => {
    requests += 1
    return { ok: false, status: 503 }
  }
  const logger = { log() {}, error() {} }

  await assert.rejects(sendTelegramAlert('alert', { env, fetchImpl, logger }), /non-2xx HTTP 503/)

  const s3 = fakeS3(() => ({ Contents: [] }))
  const exitCode = await runBackupFreshnessCli({ env, s3, now: NOW, fetchImpl, logger })
  assert.equal(exitCode, 2)
  assert.equal(requests, 2)
})

test('Telegram webhook accepts a 2xx response and sends the configured chat payload', async () => {
  const env = { TELEGRAM_BOT_TOKEN: 'bot-token', TELEGRAM_ALERT_CHAT_ID: 'chat-id' }
  let request
  const sent = await sendTelegramAlert('contract alert', {
    env,
    fetchImpl: async (url, options) => {
      request = { url, options }
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    },
    logger: { log() {}, error() {} },
  })

  assert.equal(sent, true)
  assert.equal(request.url, 'https://api.telegram.org/botbot-token/sendMessage')
  assert.deepEqual(JSON.parse(request.options.body), {
    chat_id: 'chat-id',
    text: 'contract alert',
  })
  assert.equal(TELEGRAM_REQUEST_TIMEOUT_MS, 10_000)
  assert.ok(request.options.signal instanceof AbortSignal)
  assert.equal(request.options.signal.aborted, false)
})

test('Telegram webhook requires a JSON ok=true delivery acknowledgement', async () => {
  const env = { TELEGRAM_BOT_TOKEN: 'bot-token', TELEGRAM_ALERT_CHAT_ID: 'chat-id' }
  await assert.rejects(
    sendTelegramAlert('contract alert', {
      env,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: false }),
      }),
      logger: { log() {}, error() {} },
    }),
    /did not confirm delivery/
  )
  await assert.rejects(
    sendTelegramAlert('contract alert', {
      env,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('invalid response body')
        },
      }),
      logger: { log() {}, error() {} },
    }),
    /invalid JSON/
  )
})

test('Telegram webhook rejects contradictory ok=true with a non-2xx status', async () => {
  const env = { TELEGRAM_BOT_TOKEN: 'bot-token', TELEGRAM_ALERT_CHAT_ID: 'chat-id' }
  await assert.rejects(
    sendTelegramAlert('contract alert', {
      env,
      fetchImpl: async () => ({ ok: true, status: 503 }),
      logger: { log() {}, error() {} },
    }),
    /non-2xx HTTP 503/
  )
})

test('the executable runs through a symlink instead of silently skipping the CLI', () => {
  const directory = mkdtempSync(join(tmpdir(), 'arena-backup-freshness-'))
  const link = join(directory, 'backup-freshness-check.mjs')
  try {
    symlinkSync(realpathSync('scripts/openclaw/backup-freshness-check.mjs'), link)
    const env = { ...process.env }
    for (const key of [
      'R2_ACCOUNT_ID',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
      'TELEGRAM_BOT_TOKEN',
      'TELEGRAM_ALERT_CHAT_ID',
      'TELEGRAM_CHAT_ID',
    ]) {
      env[key] = ''
    }

    const result = spawnSync(process.execPath, [link], {
      cwd: process.cwd(),
      env,
      encoding: 'utf8',
    })
    assert.equal(result.status, 2)
    assert.match(result.stderr, /Missing R2 credentials/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
