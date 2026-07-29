import 'server-only'

import type Stripe from 'stripe'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'
import {
  expireOpenSubscriptionCheckouts,
  stopStripeSubscriptionRenewals,
  type AccountDeletionOneTimeSettlementObservation,
} from '@/lib/stripe/account-deletion'
import { persistAccountDeletionOneTimeSettlementScan } from '@/lib/stripe/account-deletion-settlement'

const PREPARED_OPERATION_COLUMNS =
  'operation_id,user_id,state,stripe_customer_id,stripe_subscription_ids,prepared_at'
const PREPARED_OPERATION_KEYS = PREPARED_OPERATION_COLUMNS.split(',').sort()
const FINISH_ACK_KEYS = [
  'status',
  'operation_id',
  'user_id',
  'stripe_customer_id',
  'stripe_subscription_ids',
].sort()
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const CUSTOMER_ID_PATTERN = /^cus_[A-Za-z0-9_]+$/
const SUBSCRIPTION_ID_PATTERN = /^sub_[A-Za-z0-9_]+$/

interface PreparedAccountDeletionBillingOperation {
  operationId: string
  userId: string
  stripeCustomerId: string | null
  stripeSubscriptionIds: string[]
}

interface RpcResult {
  data: unknown
  error: { message: string } | null
}

interface QueryResult {
  data: unknown
  error: { message: string } | null
}

export interface AccountDeletionBillingReconciliationResult {
  count: number
  examined: number
  settled: number
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort()
  return keys.length === expected.length && keys.every((key, index) => key === expected[index])
}

function normalizedSubscriptionIds(value: unknown): string[] | null {
  if (
    !Array.isArray(value) ||
    value.some(
      (id) =>
        typeof id !== 'string' || id.length > 255 || !SUBSCRIPTION_ID_PATTERN.test(id as string)
    )
  ) {
    return null
  }

  const ids = value as string[]
  const normalized = [...new Set(ids)].sort()
  return normalized.length === ids.length && ids.every((id, index) => id === normalized[index])
    ? normalized
    : null
}

function parsePreparedOperation(value: unknown): PreparedAccountDeletionBillingOperation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (!hasExactKeys(row, PREPARED_OPERATION_KEYS)) return null

  const stripeSubscriptionIds = normalizedSubscriptionIds(row.stripe_subscription_ids)
  const stripeCustomerId = row.stripe_customer_id
  if (
    row.state !== 'prepared' ||
    typeof row.operation_id !== 'string' ||
    !UUID_PATTERN.test(row.operation_id) ||
    typeof row.user_id !== 'string' ||
    !UUID_PATTERN.test(row.user_id) ||
    (stripeCustomerId !== null &&
      (typeof stripeCustomerId !== 'string' ||
        stripeCustomerId.length > 255 ||
        !CUSTOMER_ID_PATTERN.test(stripeCustomerId))) ||
    !stripeSubscriptionIds ||
    (stripeCustomerId === null && stripeSubscriptionIds.length > 0) ||
    typeof row.prepared_at !== 'string' ||
    !Number.isFinite(Date.parse(row.prepared_at))
  ) {
    return null
  }

  return {
    operationId: row.operation_id,
    userId: row.user_id,
    stripeCustomerId,
    stripeSubscriptionIds,
  }
}

function isExactFinishAck(
  value: unknown,
  expected: PreparedAccountDeletionBillingOperation & { stripeSubscriptionIds: string[] }
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const ack = value as Record<string, unknown>
  const stripeSubscriptionIds = normalizedSubscriptionIds(ack.stripe_subscription_ids)
  return (
    hasExactKeys(ack, FINISH_ACK_KEYS) &&
    ack.status === 'settled' &&
    ack.operation_id === expected.operationId &&
    ack.user_id === expected.userId &&
    ack.stripe_customer_id === expected.stripeCustomerId &&
    !!stripeSubscriptionIds &&
    stripeSubscriptionIds.length === expected.stripeSubscriptionIds.length &&
    stripeSubscriptionIds.every((id, index) => id === expected.stripeSubscriptionIds[index])
  )
}

async function listPreparedOperations(
  supabase: SupabaseClient<Database>,
  limit: number
): Promise<PreparedAccountDeletionBillingOperation[]> {
  const table = Reflect.apply(supabase.from, supabase, ['account_deletion_billing_operations']) as {
    select: (columns: string) => {
      eq: (
        column: string,
        value: string
      ) => {
        order: (
          column: string,
          options: { ascending: boolean }
        ) => { limit: (count: number) => Promise<QueryResult> }
      }
    }
  }
  const { data, error } = await table
    .select(PREPARED_OPERATION_COLUMNS)
    .eq('state', 'prepared')
    .order('prepared_at', { ascending: true })
    .limit(limit)

  if (error) throw new Error(`Failed to list prepared account deletions: ${error.message}`)
  if (!Array.isArray(data) || data.length > limit) {
    throw new Error('Prepared account deletion query returned an invalid row set')
  }

  return data.map((row) => {
    const operation = parsePreparedOperation(row)
    if (!operation) {
      throw new Error('Prepared account deletion query returned an invalid operation')
    }
    return operation
  })
}

async function finishOperation(params: {
  supabase: SupabaseClient<Database>
  operation: PreparedAccountDeletionBillingOperation
  stripeSubscriptionIds: string[]
}): Promise<void> {
  const expected = { ...params.operation, stripeSubscriptionIds: params.stripeSubscriptionIds }
  const { data, error } = (await Reflect.apply(params.supabase.rpc, params.supabase, [
    'finish_account_deletion_billing_atomic',
    {
      p_user_id: params.operation.userId,
      p_operation_id: params.operation.operationId,
      p_stripe_customer_id: params.operation.stripeCustomerId,
      p_stripe_subscription_ids: params.stripeSubscriptionIds,
    },
  ])) as RpcResult

  if (error) throw new Error(`Account deletion billing finish failed: ${error.message}`)
  if (!isExactFinishAck(data, expected)) {
    throw new Error('Account deletion billing finish returned an invalid acknowledgement')
  }
}

async function reconcileOperation(params: {
  supabase: SupabaseClient<Database>
  stripeClient: Stripe
  operation: PreparedAccountDeletionBillingOperation
}): Promise<void> {
  const { operation } = params
  const subscriptionIds = new Set(operation.stripeSubscriptionIds)
  const settlements = new Map<string, AccountDeletionOneTimeSettlementObservation>()

  if (operation.stripeCustomerId) {
    const checkoutResult = await expireOpenSubscriptionCheckouts({
      stripeClient: params.stripeClient,
      customerId: operation.stripeCustomerId,
      expectedUserId: operation.userId,
    })
    checkoutResult.racedSubscriptionIds.forEach((id) => subscriptionIds.add(id))
    for (const observation of checkoutResult.oneTimeSettlements) {
      const existing = settlements.get(observation.checkoutSessionId)
      if (existing && JSON.stringify(existing) !== JSON.stringify(observation)) {
        throw new Error('Stripe one-time Checkout settlement changed during deletion retry')
      }
      settlements.set(observation.checkoutSessionId, observation)
    }

    const stopped = await stopStripeSubscriptionRenewals({
      stripeClient: params.stripeClient,
      subscriptionIds: [...subscriptionIds].sort(),
      expectedUserId: operation.userId,
      expectedCustomerId: operation.stripeCustomerId,
      deletionMode: 'recoverable',
      pauseMarker: operation.userId,
      includeCustomerSubscriptions: true,
    })
    if (stopped.customerId !== operation.stripeCustomerId) {
      throw new Error('Stripe account deletion retry returned the wrong customer')
    }
    stopped.observedSubscriptionIds.forEach((id) => subscriptionIds.add(id))
  }

  const settledSubscriptionIds = normalizedSubscriptionIds([...subscriptionIds].sort())
  if (!settledSubscriptionIds) {
    throw new Error('Stripe account deletion retry returned invalid subscription identities')
  }

  await persistAccountDeletionOneTimeSettlementScan({
    supabase: params.supabase,
    userId: operation.userId,
    stripeCustomerId: operation.stripeCustomerId,
    observations: [...settlements.values()],
  })
  await finishOperation({
    supabase: params.supabase,
    operation,
    stripeSubscriptionIds: settledSubscriptionIds,
  })
}

export async function reconcilePreparedAccountDeletionBilling(params: {
  supabase: SupabaseClient<Database>
  stripeClient: Stripe
  limit?: number
}): Promise<AccountDeletionBillingReconciliationResult> {
  const limit = params.limit ?? 5
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) {
    throw new Error('Invalid account deletion billing reconciliation limit')
  }

  const operations = await listPreparedOperations(params.supabase, limit)
  const failures: Array<{ operationId: string; error: unknown }> = []
  let settled = 0

  for (const operation of operations) {
    try {
      await reconcileOperation({ ...params, operation })
      settled++
    } catch (error) {
      failures.push({ operationId: operation.operationId, error })
    }
  }

  if (failures.length > 0) {
    const first = failures[0]
    const message = first.error instanceof Error ? first.error.message : String(first.error)
    throw new Error(
      `Failed to reconcile ${failures.length}/${operations.length} prepared account deletion(s); first ${first.operationId}: ${message}`,
      { cause: first.error }
    )
  }

  return { count: settled, examined: operations.length, settled }
}
