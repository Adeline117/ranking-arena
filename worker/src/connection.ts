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
import {
  V1_RANKING_COMMAND_CHAIN_NOT_PUBLISHED_CODE,
  isV1RankingCommandChainPublished,
} from '@/lib/cron/v1-ranking-command-chain-publication'

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
let rankingConnection: RedisConnection | null = null

/**
 * Redis for the ingest command path (ingest worker, ingest queues, ingest
 * processors). Gated by the ingest publication constant only.
 */
export function getConnection(): RedisConnection {
  // Keep the package load and TCP client construction behind the fixed V1
  // publication boundary. A caller cannot re-enable this from its environment.
  assertV1IngestExecutionPublished()

  if (connection) return connection
  connection = createRedisConnection()
  return connection
}

/**
 * Redis for the ranking command chain (arena-worker: the `arena-pipeline`
 * queue that runs the season publication). Gated by the ranking constant
 * only, so publishing the ranking chain does not require publishing ingest
 * (and vice versa). Each path keeps its own client; neither gate can open the
 * other path's queues.
 */
export function getRankingCommandChainConnection(): RedisConnection {
  if (!isV1RankingCommandChainPublished()) {
    throw Object.assign(new Error('V1 ranking command chain is not published'), {
      code: V1_RANKING_COMMAND_CHAIN_NOT_PUBLISHED_CODE,
      name: V1_RANKING_COMMAND_CHAIN_NOT_PUBLISHED_CODE,
    })
  }

  if (rankingConnection) return rankingConnection
  rankingConnection = createRedisConnection()
  return rankingConnection
}

// Private builder: only reachable after one of the two gates above passed.
function createRedisConnection(): RedisConnection {
  const url = process.env.REDIS_URL
  if (!url) {
    throw new Error(
      'REDIS_URL not set. BullMQ needs native Redis TCP connection.\n' +
        'Get it from Upstash Dashboard → Connect → ioredis.\n' +
        'Format: rediss://default:TOKEN@HOST:6379'
    )
  }

  const IORedis = loadIORedis()
  const client = new IORedis(url, {
    maxRetriesPerRequest: null, // Required by BullMQ
    enableReadyCheck: false, // Upstash compatibility
    tls: url.startsWith('rediss://') ? {} : undefined,
  })

  client.on('error', () => {
    // IORedis errors may embed the credential-bearing connection URL.
    console.error('[worker] Redis connection error')
  })

  client.on('connect', () => {
    console.log('[worker] Redis connected')
  })

  return client
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

export async function closeRankingCommandChainConnection(): Promise<void> {
  if (!isV1RankingCommandChainPublished()) return

  if (rankingConnection) {
    await rankingConnection.quit()
    rankingConnection = null
  }
}
