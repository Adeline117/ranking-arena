/**
 * PostgreSQL connection pool and Supabase server client.
 * Used by LeaderboardService for direct DB access.
 *
 * In production, this connects to Supabase's PostgreSQL via connection pooler.
 * In development, connects to local PostgreSQL.
 *
 * Features:
 * - SSL support for Supabase production connections
 * - Retry with exponential backoff for transient failures
 * - Serverless-optimized pool sizing
 * - Connection error recovery (pool recreation on fatal errors)
 */

import { Pool, type PoolConfig } from 'pg';
import { createServerClient as createSupabaseServerClient } from '@supabase/ssr';
import type { ReadonlyRequestCookies } from 'next/dist/server/web/spec-extension/adapters/request-cookies';
import { logger } from '@/lib/logger'

let pool: Pool | null = null;

/** Max retries for transient connection errors */
const MAX_RETRIES = 2;
/** Base delay between retries (ms) */
const RETRY_BASE_DELAY_MS = 200;

/** Errors that indicate a transient/recoverable connection issue */
const TRANSIENT_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'CONNECTION_ENDED',
  '57P01', // admin_shutdown
  '57P03', // cannot_connect_now
  '08000', // connection_exception
  '08003', // connection_does_not_exist
  '08006', // connection_failure
]);

function isTransientError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; message?: string };
  if (e.code && TRANSIENT_ERROR_CODES.has(e.code)) return true;
  if (e.message?.includes('Connection terminated unexpectedly')) return true;
  if (e.message?.includes('Client has encountered a connection error')) return true;
  if (e.message?.includes('timeout')) return true;
  return false;
}

function resetPool(): void {
  if (pool) {
    // eslint-disable-next-line no-restricted-syntax -- Intentional: cleanup errors are non-critical
    pool.end().catch(() => { /* ignore cleanup errors */ });
    pool = null;
  }
}

export function getPool(): Pool {
  if (!pool) {
    const isProduction = process.env.NODE_ENV === 'production';
    const connectionString = process.env.DATABASE_URL || 'postgresql://claude:arena_dev@localhost:5432/ranking_arena';

    const config: PoolConfig = {
      connectionString,
      // Production: 3 connections per function instance.
      // Supabase max_connections = 60 (verified 2026-04-08 via SHOW max_connections).
      // With ~10-20 concurrent serverless function instances during cron storms,
      // 10 per instance × 20 instances = 200 connections → MaxClientsInSessionMode error.
      // Reduced to 3 per instance: 3 × 20 = 60, fits within limit.
      // Idle timeout shortened so connections release faster between cron runs.
      max: isProduction ? 3 : 10,
      idleTimeoutMillis: isProduction ? 5000 : 30000,
      connectionTimeoutMillis: isProduction ? 15000 : 10000,
      // Keep connections alive through load balancer/pooler
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
      // statement_timeout: kill queries that run longer than 30s to prevent
      // connection hogging in serverless (Vercel function timeout is 60s)
      statement_timeout: isProduction ? 30000 : 60000,
      // allowExitOnIdle: let pool drain when serverless function goes idle
      // Prevents connections from persisting after Vercel function freezes
      allowExitOnIdle: isProduction,
    };

    // Supabase requires SSL in production
    if (isProduction && connectionString.includes('supabase')) {
      config.ssl = { rejectUnauthorized: false };
    }

    pool = new Pool(config);

    // Handle pool-level errors to prevent unhandled rejections
    pool.on('error', (err) => {
      logger.error('[db/pool] Unexpected pool error:', err.message);
      resetPool();
    });

    // Log connection pool metrics on connect/remove for leak detection
    pool.on('connect', () => {
      logger.debug(`[db/pool] Connection acquired (total: ${pool?.totalCount}, idle: ${pool?.idleCount}, waiting: ${pool?.waitingCount})`);
    });
    pool.on('remove', () => {
      logger.debug(`[db/pool] Connection removed (total: ${pool?.totalCount}, idle: ${pool?.idleCount}, waiting: ${pool?.waitingCount})`);
    });
  }
  return pool;
}

async function queryWithRetry<T>(
  text: string,
  params: unknown[] | undefined,
): Promise<{ rows: T[]; rowCount: number }> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await getPool().query(text, params);
      return { rows: result.rows as T[], rowCount: result.rowCount || 0 };
    } catch (err) {
      lastError = err;

      if (!isTransientError(err) || attempt === MAX_RETRIES) {
        break;
      }

      // Reset pool on connection errors so next attempt gets fresh connection
      resetPool();

      // Exponential backoff: 200ms, 400ms
      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

export async function query<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params?: unknown[],
): Promise<{ rows: T[]; rowCount: number }> {
  return queryWithRetry<T>(text, params);
}

export async function queryOne<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params?: unknown[],
): Promise<T | null> {
  const result = await queryWithRetry<T>(text, params);
  return result.rows[0] || null;
}

/**
 * Create a Supabase server client for Server Components
 * Used to access auth session and Supabase features in RSC
 */
export function createClient(cookieStore: ReadonlyRequestCookies) {
  return createSupabaseServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch (_err) {
            // The `setAll` method was called from a Server Component.
            // This can be ignored if you have middleware refreshing
            // user sessions.
          }
        },
      },
    }
  )
}
