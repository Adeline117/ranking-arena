/**
 * Redis connection for historical BullMQ workers.
 *
 * BullMQ requires a native Redis TCP connection (ioredis), NOT the Upstash
 * REST API used by the main app. Set REDIS_URL in worker/.env:
 *
 *   REDIS_URL=rediss://default:TOKEN@HOST:6379
 *
 * Get this from Upstash Dashboard → your database → "Connect" → "ioredis".
 */

import { createRequire } from 'node:module'
import {
  assertV1IngestExecutionPublished,
  isV1IngestExecutionPublished,
} from '@/lib/ingest/v1-execution-publication'

type IORedisConstructor = typeof import('ioredis').default
type RedisConnection = InstanceType<IORedisConstructor>

// Resolve from the repository package boundary without loading ioredis. This
// stays compatible with the existing Jest CommonJS transform as well as tsx.
const nodeRequire = createRequire(`${process.cwd()}/package.json`)

function loadIORedis(): IORedisConstructor {
  const loaded = nodeRequire('ioredis') as IORedisConstructor | { default: IORedisConstructor }
  return typeof loaded === 'function' ? loaded : loaded.default
}

let connection: RedisConnection | null = null

export function getConnection(): RedisConnection {
  // Keep the package load and TCP client construction behind the fixed V1
  // publication boundary. A caller cannot re-enable this from its environment.
  assertV1IngestExecutionPublished()

  if (connection) return connection

  const url = process.env.REDIS_URL
  if (!url) {
    throw new Error(
      'REDIS_URL not set. BullMQ needs native Redis TCP connection.\n' +
        'Get it from Upstash Dashboard → Connect → ioredis.\n' +
        'Format: rediss://default:TOKEN@HOST:6379'
    )
  }

  const IORedis = loadIORedis()
  connection = new IORedis(url, {
    maxRetriesPerRequest: null, // Required by BullMQ
    enableReadyCheck: false, // Upstash compatibility
    tls: url.startsWith('rediss://') ? {} : undefined,
  })

  connection.on('error', () => {
    // IORedis errors may embed the credential-bearing connection URL.
    console.error('[worker] Redis connection error')
  })

  connection.on('connect', () => {
    console.log('[worker] Redis connected')
  })

  return connection
}

export async function closeConnection(): Promise<void> {
  // A disabled V1 process must not send even a Redis QUIT command. There
  // cannot be a connection from this source path once getConnection is gated.
  if (!isV1IngestExecutionPublished()) return

  if (connection) {
    await connection.quit()
    connection = null
  }
}
