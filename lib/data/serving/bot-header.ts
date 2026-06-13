/**
 * Bot profile header data (spec §1.3). A bot's profile is a traders row
 * (trader_kind='bot'); this fetches the bot-instance metadata (pair, strategy,
 * direction, runtime, profit-share %, owner link) via the public
 * arena_bot_header RPC, keyed by the same (source, exchange_trader_id) the page
 * already resolved. Returns null for non-bot traders.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface BotHeader {
  botId: string | null
  pair: string | null
  productType: string | null
  botStrategy: 'martingale' | 'grid' | 'ai' | null
  direction: string | null
  runtimeDays: number | null
  profitShareRate: number | null
  createdAtOrigin: string | null
  status: string | null
  ownerNickname: string | null
  ownerTraderKey: string | null
  ownerPlatform: string | null
}

export async function getBotHeader(
  supabase: SupabaseClient,
  params: { source: string; traderKey: string }
): Promise<BotHeader | null> {
  const { data, error } = await supabase.rpc('arena_bot_header', {
    p_source: params.source,
    p_trader_key: params.traderKey,
  })
  if (error || !data) return null
  const d = data as Record<string, unknown>
  const str = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : null)
  const numOrNull = (k: string) => (typeof d[k] === 'number' ? (d[k] as number) : null)
  const strat = str('bot_strategy')
  return {
    botId: str('bot_id'),
    pair: str('pair'),
    productType: str('product_type'),
    botStrategy: strat === 'martingale' || strat === 'grid' || strat === 'ai' ? strat : null,
    direction: str('direction'),
    runtimeDays: numOrNull('runtime_days'),
    profitShareRate: numOrNull('profit_share_rate'),
    createdAtOrigin: str('created_at_origin'),
    status: str('status'),
    ownerNickname: str('owner_nickname'),
    ownerTraderKey: str('owner_trader_key'),
    ownerPlatform: str('owner_platform'),
  }
}
