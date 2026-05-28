/**
 * Redis connection for BullMQ workers.
 *
 * BullMQ requires a native Redis TCP connection (ioredis), NOT the Upstash
 * REST API used by the main app. Set REDIS_URL in worker/.env:
 *
 *   REDIS_URL=rediss://default:TOKEN@HOST:6379
 *
 * Get this from Upstash Dashboard → your database → "Connect" → "ioredis".
 */

import IORedis from 'ioredis'

let connection: IORedis | null = null

export function getConnection(): IORedis {
  if (connection) return connection

  const url = process.env.REDIS_URL
  if (!url) {
    throw new Error(
      'REDIS_URL not set. BullMQ needs native Redis TCP connection.\n' +
        'Get it from Upstash Dashboard → Connect → ioredis.\n' +
        'Format: rediss://default:TOKEN@HOST:6379'
    )
  }

  connection = new IORedis(url, {
    maxRetriesPerRequest: null, // Required by BullMQ
    enableReadyCheck: false, // Upstash compatibility
    tls: url.startsWith('rediss://') ? {} : undefined,
  })

  connection.on('error', (err) => {
    console.error('[worker] Redis connection error:', err.message)
  })

  connection.on('connect', () => {
    console.log('[worker] Redis connected')
  })

  return connection
}

export async function closeConnection(): Promise<void> {
  if (connection) {
    await connection.quit()
    connection = null
  }
}
