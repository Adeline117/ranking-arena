/**
 * V1 legacy ranking command-chain publication boundary.
 *
 * The retired worker/scheduler/caller chain must remain unavailable while V1
 * verification is incomplete. This deliberately has no environment override:
 * reopening it requires a separately reviewed source change. It is a
 * source-only guard and cannot stop an already-running process or a schedule
 * already persisted outside this checkout.
 */

export const V1_RANKING_COMMAND_CHAIN_PUBLISHED = false as const

export const V1_RANKING_COMMAND_CHAIN_NOT_PUBLISHED_CODE =
  'RANKING_COMMAND_CHAIN_NOT_PUBLISHED' as const

export function isV1RankingCommandChainPublished(): boolean {
  return V1_RANKING_COMMAND_CHAIN_PUBLISHED
}
