/**
 * 实时用户活动通知
 *
 * 关键事件发生时立刻发 Telegram，零 LLM 消耗，纯模板字符串。
 * 通过 sendAlert（走 Telegram + 其他已配置渠道），内置限流。
 */

import { sendRateLimitedAlert } from '@/lib/alerts/send-alert'
import { logger } from '@/lib/logger'

/**
 * 新用户注册通知
 */
export async function notifyNewUser(handle: string | null, email: string | null): Promise<void> {
  const displayName = handle || email || '匿名用户'
  try {
    await sendRateLimitedAlert(
      {
        level: 'info',
        title: '🆕 新用户注册',
        message: `${displayName} 刚刚注册了 Arena`,
      },
      `new-user:${displayName}`,
      60000 // 同一用户 1 分钟内不重复
    )
  } catch (err) {
    logger.error('[activity-alerts] 新用户通知失败:', err)
  }
}

/**
 * 交易员认领通知
 */
export async function notifyTraderClaim(
  userHandle: string | null,
  traderId: string,
  source: string
): Promise<void> {
  const displayName = userHandle || '用户'
  try {
    await sendRateLimitedAlert(
      {
        level: 'info',
        title: '👤 新认领申请',
        message: `${displayName} 认领了 ${traderId}@${source}`,
      },
      `claim:${traderId}:${source}`,
      60000
    )
  } catch (err) {
    logger.error('[activity-alerts] 认领通知失败:', err)
  }
}

/**
 * 新建小组通知
 */
export async function notifyNewGroup(
  creatorHandle: string | null,
  groupName: string
): Promise<void> {
  const displayName = creatorHandle || '用户'
  try {
    await sendRateLimitedAlert(
      {
        level: 'info',
        title: '👥 新小组创建',
        message: `${displayName} 创建了小组「${groupName}」`,
      },
      `group:${groupName}`,
      60000
    )
  } catch (err) {
    logger.error('[activity-alerts] 小组通知失败:', err)
  }
}
