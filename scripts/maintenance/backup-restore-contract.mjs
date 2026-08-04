import { createReadStream, statSync } from 'node:fs'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'

// Complete arena+public backups are currently ~5 GB compressed. Keep the
// independent 1 GB floor on both sides of the backup/restore boundary so a
// valid-but-empty 20-byte gzip can never become a restore point.
export const COMPLETE_BACKUP_MIN_BYTES = 1024 * 1024 * 1024
export const ARENA_BACKUP_COMPLETION_CONTRACT = 'arena.pg-dump-complete.v1'
export const PG_DUMP_RESTRICT_TOKEN_PATTERN = /^[0-9A-Za-z]{1,256}$/
export const ARENA_BACKUP_COMPLETION_TOKEN_PATTERN = /^[0-9a-f]{64}$/
export const IMMUTABLE_BACKUP_FILENAME_PATTERN =
  /^arena-backup-(\d{8}T\d{9}Z)-([0-9a-f]{32})-(schemas|full)\.sql\.gz$/
export const LEGACY_COMPLETE_BACKUP_FILENAME_PATTERN =
  /^arena-backup-(\d{8})-(schemas|full)\.sql\.gz$/

export function parseCompleteBackupFilename(filename) {
  if (typeof filename !== 'string') return null

  const immutable = filename.match(IMMUTABLE_BACKUP_FILENAME_PATTERN)
  if (immutable) {
    return {
      date: immutable[1].slice(0, 8),
      format: 'immutable',
      mode: immutable[3],
      runId: immutable[2],
      timestamp: immutable[1],
    }
  }

  const legacy = filename.match(LEGACY_COMPLETE_BACKUP_FILENAME_PATTERN)
  if (legacy) {
    return {
      date: legacy[1],
      format: 'legacy',
      mode: legacy[2],
      runId: null,
      timestamp: null,
    }
  }

  return null
}

const PG_DUMP_PREFIX = '--\n-- PostgreSQL database dump\n--\n\n'
const PG_DUMP_COMPLETE = '--\n-- PostgreSQL database dump complete\n--\n\n'
const COMPLETION_WINDOW_BYTES = 64 * 1024

export function arenaBackupCompletionSentinel(token) {
  if (!ARENA_BACKUP_COMPLETION_TOKEN_PATTERN.test(token)) {
    throw new Error('backup completion token contract is invalid')
  }
  return `-- ARENA BACKUP COMPLETE ${ARENA_BACKUP_COMPLETION_CONTRACT} token=${token}\n`
}

export function arenaCompletionTokenFromMetadata(metadata) {
  const normalized = Object.fromEntries(
    Object.entries(metadata ?? {}).map(([key, value]) => [key.toLowerCase(), String(value).trim()])
  )
  const contract = normalized['completion-contract']
  const token = normalized['completion-token']
  if (contract === undefined && token === undefined) return undefined
  if (
    contract !== ARENA_BACKUP_COMPLETION_CONTRACT ||
    !ARENA_BACKUP_COMPLETION_TOKEN_PATTERN.test(token ?? '')
  ) {
    throw new Error('backup completion metadata is incomplete or invalid')
  }
  return token
}

/**
 * Keep PostgreSQL credentials out of CLI argv while preserving libpq URI
 * semantics. An explicit query-string password takes precedence over the
 * authority password, as it does for libpq.
 */
export function preparePostgresConnection(databaseUrl, label = 'database URL') {
  let parsedUrl
  try {
    parsedUrl = new URL(databaseUrl)
  } catch {
    throw new Error(`${label} must be a valid PostgreSQL URL`)
  }

  if (parsedUrl.protocol !== 'postgres:' && parsedUrl.protocol !== 'postgresql:') {
    throw new Error(`${label} must use the postgres or postgresql protocol`)
  }
  if (parsedUrl.hash !== '') {
    throw new Error(`${label} fragments are unsupported`)
  }

  const decode = (value) => {
    try {
      return decodeURIComponent(value)
    } catch {
      throw new Error(`${label} has invalid percent-encoding`)
    }
  }

  const authorityStart = databaseUrl.indexOf('://') + 3
  const authorityEndOffset = databaseUrl.slice(authorityStart).search(/[/?#]/)
  const authorityEnd =
    authorityEndOffset === -1 ? databaseUrl.length : authorityStart + authorityEndOffset
  const authority = databaseUrl.slice(authorityStart, authorityEnd)
  const atIndex = authority.lastIndexOf('@')
  const userInfo = atIndex >= 0 ? authority.slice(0, atIndex) : ''
  const passwordSeparator = userInfo.indexOf(':')
  const hasAuthorityPassword = passwordSeparator >= 0
  const authorityPassword = hasAuthorityPassword
    ? decode(userInfo.slice(passwordSeparator + 1))
    : undefined
  const sanitizedAuthority = hasAuthorityPassword
    ? `${userInfo.slice(0, passwordSeparator)}${authority.slice(atIndex)}`
    : authority

  // Work on the raw query so unrelated libpq values such as `a+b` retain
  // their exact connection meaning rather than being normalized by
  // URLSearchParams.
  const remainder = databaseUrl.slice(authorityEnd)
  const queryIndex = remainder.indexOf('?')
  const path = queryIndex === -1 ? remainder : remainder.slice(0, queryIndex)
  const rawQuery = queryIndex === -1 ? null : remainder.slice(queryIndex + 1)
  const queryPasswords = []
  const safeQueryParts = []

  if (rawQuery !== null) {
    for (const part of rawQuery.split('&')) {
      const separator = part.indexOf('=')
      const rawKey = separator === -1 ? part : part.slice(0, separator)
      if (decode(rawKey) === 'password') {
        queryPasswords.push(decode(separator === -1 ? '' : part.slice(separator + 1)))
      } else {
        safeQueryParts.push(part)
      }
    }
  }

  const safeQuery = safeQueryParts.length > 0 ? `?${safeQueryParts.join('&')}` : ''
  const password = queryPasswords.length > 0 ? queryPasswords.at(-1) : authorityPassword

  return {
    connectionUrl: `${databaseUrl.slice(0, authorityStart)}${sanitizedAuthority}${path}${safeQuery}`,
    password,
  }
}

function createCompletionWindowSink() {
  const headChunks = []
  let headBytes = 0
  let tailChunks = []
  let tailBytes = 0
  let uncompressedBytes = 0

  const sink = new Writable({
    write(value, _encoding, callback) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
      uncompressedBytes += chunk.length

      if (headBytes < COMPLETION_WINDOW_BYTES) {
        const slice = chunk.subarray(0, COMPLETION_WINDOW_BYTES - headBytes)
        headChunks.push(Buffer.from(slice))
        headBytes += slice.length
      }

      if (chunk.length >= COMPLETION_WINDOW_BYTES) {
        tailChunks = [Buffer.from(chunk.subarray(chunk.length - COMPLETION_WINDOW_BYTES))]
        tailBytes = COMPLETION_WINDOW_BYTES
      } else {
        tailChunks.push(Buffer.from(chunk))
        tailBytes += chunk.length
        while (tailBytes > COMPLETION_WINDOW_BYTES) {
          const excess = tailBytes - COMPLETION_WINDOW_BYTES
          const first = tailChunks[0]
          if (first.length <= excess) {
            tailChunks.shift()
            tailBytes -= first.length
          } else {
            tailChunks[0] = first.subarray(excess)
            tailBytes -= excess
          }
        }
      }
      callback()
    },
  })

  return {
    sink,
    windows: () => ({
      head: Buffer.concat(headChunks).toString('latin1'),
      // The deque retains at most 64 KiB and materializes it only once, after
      // the complete gzip stream (including CRC/ISIZE) has been consumed.
      tail: Buffer.concat(tailChunks, tailBytes).toString('latin1'),
      uncompressedBytes,
    }),
  }
}

function assertPgDumpCompletion({ head, tail, uncompressedBytes }, completionToken) {
  if (uncompressedBytes === 0 || !head.startsWith(PG_DUMP_PREFIX)) {
    throw new Error('PostgreSQL dump prefix is missing')
  }

  const afterPrefix = head.slice(PG_DUMP_PREFIX.length)
  const restrictedHeader = /^\\restrict ([0-9A-Za-z]{1,256})\n\n/.exec(afterPrefix)
  if (afterPrefix.startsWith('\\restrict') && !restrictedHeader) {
    throw new Error('PostgreSQL restrict header is malformed')
  }

  if (restrictedHeader) {
    const restrictToken = restrictedHeader[1]
    const officialFooter = `${PG_DUMP_COMPLETE}\\unrestrict ${restrictToken}\n\n`
    if (completionToken === undefined) {
      // Every existing complete R2 restore point was produced by PG17.8/17.10
      // with its native 63-character generated key. Do not broaden the legacy
      // path to manually supplied or pre-restrict formats without new evidence.
      if (!/^[0-9A-Za-z]{63}$/.test(restrictToken)) {
        throw new Error('legacy PostgreSQL restrict token is not the native PG17 shape')
      }
      if (!tail.endsWith(officialFooter)) {
        throw new Error('matching PostgreSQL unrestrict completion footer is missing')
      }
      return
    }
    if (restrictToken !== completionToken) {
      throw new Error('Arena metadata token does not match the PostgreSQL restrict token')
    }
    if (!tail.endsWith(officialFooter + arenaBackupCompletionSentinel(completionToken))) {
      throw new Error('Arena completion sentinel is missing from the exact stream end')
    }
    return
  }

  if (completionToken !== undefined) {
    throw new Error('Arena backups require a PostgreSQL restrict token')
  }
  throw new Error('legacy R2 backups require the evidenced PG17 restrict header')
}

/**
 * Validate gzip CRC/ISIZE and pg_dump completion semantics in one complete
 * streaming decompression. Only bounded head/tail windows are retained.
 */
export async function assertBackupArtifact(
  localPath,
  minimumBytes,
  { completionToken, timeoutMs = 10 * 60_000 } = {}
) {
  const size = statSync(localPath).size
  if (!Number.isSafeInteger(minimumBytes) || minimumBytes < 1) {
    throw new Error('backup minimum size contract is invalid')
  }
  if (size < minimumBytes) {
    throw new Error(`backup artifact is incomplete: ${size} bytes < required ${minimumBytes} bytes`)
  }

  if (
    completionToken !== undefined &&
    !ARENA_BACKUP_COMPLETION_TOKEN_PATTERN.test(completionToken)
  ) {
    throw new Error('backup completion token contract is invalid')
  }

  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('backup verification timeout contract is invalid')
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  timeout.unref()
  const { sink, windows } = createCompletionWindowSink()
  try {
    await pipeline(createReadStream(localPath), createGunzip(), sink, {
      signal: controller.signal,
    })
    assertPgDumpCompletion(windows(), completionToken)
  } catch {
    throw new Error('backup artifact failed gzip or pg_dump completion verification')
  } finally {
    clearTimeout(timeout)
  }

  return size
}
