import 'server-only'

import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'
import type { AccountDeletionOneTimeSettlementObservation } from './account-deletion'

interface RpcResult {
  data: unknown
  error: { message: string } | null
}

interface SettlementSyncAck {
  scanToken: string
  observedSessionIds: string[]
  pendingSessionIds: string[]
  terminalSessionIds: string[]
}

export interface SettlementReadyAck {
  ready: boolean
  pendingSessionIds: string[]
  pendingLifetimeReservations: number
  pendingTips: number
}

const SYNC_ACK_KEYS = [
  'status',
  'user_id',
  'stripe_customer_id',
  'scan_token',
  'observed_session_ids',
  'pending_session_ids',
  'terminal_session_ids',
].sort()
const READY_ACK_KEYS = [
  'status',
  'user_id',
  'scan_token',
  'ready',
  'pending_session_ids',
  'pending_lifetime_reservations',
  'pending_tips',
].sort()
const CHECKOUT_SESSION_ID_PATTERN = /^cs_[A-Za-z0-9_]+$/

function exactKeys(value: Record<string, unknown>, expectedKeys: string[]): boolean {
  const keys = Object.keys(value).sort()
  return (
    keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index])
  )
}

function sortedUniqueSessionIds(value: unknown): string[] | null {
  if (
    !Array.isArray(value) ||
    value.some(
      (sessionId) =>
        typeof sessionId !== 'string' ||
        sessionId.length > 255 ||
        !CHECKOUT_SESSION_ID_PATTERN.test(sessionId)
    )
  ) {
    return null
  }
  const normalized = [...new Set(value as string[])].sort()
  return normalized.length === value.length &&
    normalized.every((sessionId, index) => sessionId === value[index])
    ? normalized
    : null
}

function rpcRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

async function callRpc(
  supabase: SupabaseClient<Database>,
  functionName: string,
  args: Record<string, unknown>
): Promise<RpcResult> {
  return (await Reflect.apply(supabase.rpc, supabase, [functionName, args])) as RpcResult
}

export async function persistAccountDeletionOneTimeSettlementScan(params: {
  supabase: SupabaseClient<Database>
  userId: string
  stripeCustomerId: string | null
  observations: AccountDeletionOneTimeSettlementObservation[]
  scanToken?: string
}): Promise<SettlementSyncAck> {
  const observations = [...params.observations].sort((left, right) =>
    left.checkoutSessionId < right.checkoutSessionId
      ? -1
      : left.checkoutSessionId > right.checkoutSessionId
        ? 1
        : 0
  )
  const observedSessionIds = observations.map(({ checkoutSessionId }) => checkoutSessionId)
  if (
    new Set(observedSessionIds).size !== observedSessionIds.length ||
    observedSessionIds.some(
      (sessionId) => sessionId.length > 255 || !CHECKOUT_SESSION_ID_PATTERN.test(sessionId)
    ) ||
    observations.some((observation) => observation.stripeCustomerId !== params.stripeCustomerId)
  ) {
    throw new Error('Account deletion one-time settlement observations are inconsistent')
  }

  const scanToken = params.scanToken ?? randomUUID()
  const { data, error } = await callRpc(
    params.supabase,
    'sync_account_deletion_one_time_settlements',
    {
      p_user_id: params.userId,
      p_stripe_customer_id: params.stripeCustomerId,
      p_scan_token: scanToken,
      p_observations: observations.map((observation) => ({
        checkout_session_id: observation.checkoutSessionId,
        livemode: observation.livemode,
        stripe_customer_id: observation.stripeCustomerId,
        product_kind: observation.productKind,
        stripe_status: observation.stripeStatus,
        payment_status: observation.paymentStatus,
        ownership_status: observation.ownershipStatus,
      })),
    }
  )
  if (error) {
    throw new Error(`Failed to persist account deletion settlement scan: ${error.message}`)
  }

  const ack = rpcRecord(data)
  if (
    !ack ||
    !exactKeys(ack, SYNC_ACK_KEYS) ||
    ack.status !== 'synced' ||
    ack.user_id !== params.userId ||
    ack.stripe_customer_id !== params.stripeCustomerId ||
    ack.scan_token !== scanToken
  ) {
    throw new Error('Settlement scan RPC returned an invalid acknowledgement')
  }
  const acknowledgedObservedIds = sortedUniqueSessionIds(ack.observed_session_ids)
  const pendingSessionIds = sortedUniqueSessionIds(ack.pending_session_ids)
  const terminalSessionIds = sortedUniqueSessionIds(ack.terminal_session_ids)
  const acknowledgedPartition =
    pendingSessionIds && terminalSessionIds
      ? [...pendingSessionIds, ...terminalSessionIds].sort()
      : null
  if (
    !acknowledgedObservedIds ||
    !pendingSessionIds ||
    !terminalSessionIds ||
    !acknowledgedPartition ||
    acknowledgedObservedIds.length !== observedSessionIds.length ||
    !acknowledgedObservedIds.every((sessionId, index) => sessionId === observedSessionIds[index]) ||
    acknowledgedPartition.length !== acknowledgedObservedIds.length ||
    !acknowledgedPartition.every((sessionId, index) => sessionId === acknowledgedObservedIds[index])
  ) {
    throw new Error('Settlement scan RPC did not acknowledge the exact observed Session set')
  }

  return { scanToken, observedSessionIds, pendingSessionIds, terminalSessionIds }
}

export async function checkAccountDeletionOneTimeSettlementsReady(params: {
  supabase: SupabaseClient<Database>
  userId: string
  scanToken: string
}): Promise<SettlementReadyAck> {
  const { data, error } = await callRpc(
    params.supabase,
    'check_account_deletion_one_time_settlements_ready',
    {
      p_user_id: params.userId,
      p_scan_token: params.scanToken,
    }
  )
  if (error) {
    throw new Error(`Failed to verify account deletion settlement readiness: ${error.message}`)
  }

  const ack = rpcRecord(data)
  if (
    !ack ||
    !exactKeys(ack, READY_ACK_KEYS) ||
    (ack.status !== 'ready' && ack.status !== 'pending') ||
    ack.user_id !== params.userId ||
    ack.scan_token !== params.scanToken ||
    typeof ack.ready !== 'boolean' ||
    ack.ready !== (ack.status === 'ready') ||
    !Number.isSafeInteger(ack.pending_lifetime_reservations) ||
    (ack.pending_lifetime_reservations as number) < 0 ||
    !Number.isSafeInteger(ack.pending_tips) ||
    (ack.pending_tips as number) < 0
  ) {
    throw new Error('Settlement readiness RPC returned an invalid acknowledgement')
  }
  const pendingSessionIds = sortedUniqueSessionIds(ack.pending_session_ids)
  if (
    !pendingSessionIds ||
    (ack.ready &&
      (pendingSessionIds.length > 0 ||
        ack.pending_lifetime_reservations !== 0 ||
        ack.pending_tips !== 0))
  ) {
    throw new Error('Settlement readiness RPC returned contradictory pending state')
  }

  return {
    ready: ack.ready,
    pendingSessionIds,
    pendingLifetimeReservations: ack.pending_lifetime_reservations as number,
    pendingTips: ack.pending_tips as number,
  }
}
