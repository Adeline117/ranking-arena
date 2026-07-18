/**
 * 统一计数器服务
 *
 * 所有 API route 中的计数器操作必须使用这个模块。
 * 它强制：
 * 1. 使用原子 RPC（不允许 read-then-write fallback）
 * 2. fire-and-forget（不阻塞响应）
 * 3. 统一错误处理（日志 + 不影响主流程）
 *
 * 直接调用 .rpc('increment_*') / .rpc('decrement_*') 会被 pre-push hook 拦截。
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'
import { fireAndForget } from '@/lib/utils/logger'

type PublicFunctions = Database['public']['Functions']
type CounterRpcName = Extract<
  keyof PublicFunctions,
  `increment_${string}_count` | `decrement_${string}_count`
>
type CounterRpcArgs<Name extends CounterRpcName> = PublicFunctions[Name]['Args']

/**
 * Fire-and-forget 计数器更新。不阻塞响应，失败只记日志。
 */
export function updateCount<Name extends CounterRpcName>(
  supabase: SupabaseClient<Database>,
  rpcName: Name,
  params: CounterRpcArgs<Name>,
  context: string
): void {
  fireAndForget(
    supabase.rpc(rpcName, params).then(({ error }) => {
      if (error) throw error
    }),
    context
  )
}

/**
 * 需要等待结果的计数器更新（用于需要返回新计数的场景）。
 * 仅在 API 响应需要返回新计数时使用。
 */
export async function updateCountSync<Name extends CounterRpcName>(
  supabase: SupabaseClient<Database>,
  rpcName: Name,
  params: CounterRpcArgs<Name>,
  context: string
): Promise<number | null> {
  const { data, error } = await supabase.rpc(rpcName, params).maybeSingle()

  if (error) {
    const { logger } = await import('@/lib/logger')
    logger.warn(`[counters] ${context} failed:`, error.message)
    return null
  }

  // RPC functions return the new count in various column names
  if (data && typeof data === 'object') {
    const values = Object.values(data as Record<string, unknown>)
    const numVal = values.find((v) => typeof v === 'number')
    return (numVal as number) ?? null
  }
  return typeof data === 'number' ? data : null
}
