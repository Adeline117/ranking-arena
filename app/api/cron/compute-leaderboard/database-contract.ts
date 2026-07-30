import type { SupabaseClient } from '@supabase/supabase-js'

interface RpcError {
  code?: string | null
  message?: string | null
}

async function requireInvalidParameterProbe(
  operation: string,
  call: () => PromiseLike<{ error: RpcError | null }>
): Promise<void> {
  let result: { error: RpcError | null }
  try {
    result = await call()
  } catch (error) {
    throw new Error(
      `${operation} contract probe threw: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  if (result.error?.code !== '22023') {
    const detail = result.error
      ? `${result.error.code ?? 'unknown'}: ${result.error.message ?? 'unknown error'}`
      : 'invalid probe unexpectedly succeeded'
    throw new Error(`${operation} contract unavailable (${detail})`)
  }
}

/**
 * Verify migration-first deployment before any live leaderboard DML. Both
 * probes are deliberately invalid and must stop inside argument validation;
 * 42883/PGRST202 also catches an unrefreshed PostgREST schema cache.
 */
export async function assertRankPublicationDatabaseContract(
  supabase: SupabaseClient
): Promise<void> {
  await requireInvalidParameterProbe('eligibility-aware rerank RPC', () =>
    supabase.rpc('rerank_public_eligible_leaderboard', {
      p_season_id: '__contract_probe__',
    })
  )
  await requireInvalidParameterProbe('rank-authoritative count RPC', () =>
    supabase.rpc('refresh_public_rank_count_cache_for_seasons', {
      p_season_ids: [],
    })
  )
}
