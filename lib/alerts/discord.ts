/**
 * Discord Webhook Integration
 *
 * Sends formatted alert messages to Discord channels via webhooks.
 * Supports rich embeds for rank changes, new top traders, and pipeline alerts.
 *
 * Configure via env:
 *   DISCORD_WEBHOOK_URL          — Primary alerts channel
 *   DISCORD_WEBHOOK_URL_TRADING  — Trading/rank change alerts (optional, falls back to primary)
 *
 * Discord embed color reference:
 *   - Red (critical): 0xff0000
 *   - Yellow (warning): 0xffcc00
 *   - Green (success/info): 0x00cc66
 *   - Blue (report): 0x5865f2
 */

import { logger } from '@/lib/logger'

// ============================================
// Types
// ============================================

export type DiscordAlertLevel = 'critical' | 'warning' | 'info' | 'report'

interface DiscordEmbedField {
  name: string
  value: string
  inline?: boolean
}

interface DiscordEmbed {
  title?: string
  description?: string
  color?: number
  fields?: DiscordEmbedField[]
  footer?: { text: string; icon_url?: string }
  timestamp?: string
  url?: string
  thumbnail?: { url: string }
  author?: { name: string; url?: string; icon_url?: string }
}

interface DiscordWebhookPayload {
  content?: string
  embeds?: DiscordEmbed[]
  username?: string
  avatar_url?: string
}

// ============================================
// Constants
// ============================================

const LEVEL_COLORS: Record<DiscordAlertLevel, number> = {
  critical: 0xff0000,
  warning: 0xffcc00,
  info: 0x00cc66,
  report: 0x5865f2,
}

const LEVEL_EMOJI: Record<DiscordAlertLevel, string> = {
  critical: '\u{1F534}',   // red circle
  warning: '\u{1F7E1}',    // yellow circle
  info: '\u{1F7E2}',       // green circle
  report: '\u{1F4CA}',     // chart
}

const BOT_USERNAME = 'Arena Bot'
const BOT_AVATAR = 'https://www.arenafi.org/favicon.ico'

// ============================================
// Core sending
// ============================================

async function sendToWebhook(webhookUrl: string, payload: DiscordWebhookPayload): Promise<boolean> {
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...payload,
        username: payload.username || BOT_USERNAME,
        avatar_url: payload.avatar_url || BOT_AVATAR,
      }),
    })

    if (!res.ok) {
      const body = await res.text()
      logger.error(`[Discord] Webhook failed: ${res.status} ${body}`)
      return false
    }
    return true
  } catch (err) {
    logger.error('[Discord] Webhook error:', err)
    return false
  }
}

function getWebhookUrl(channel?: 'primary' | 'trading'): string | null {
  if (channel === 'trading') {
    return process.env.DISCORD_WEBHOOK_URL_TRADING || process.env.DISCORD_WEBHOOK_URL || null
  }
  return process.env.DISCORD_WEBHOOK_URL || null
}

// ============================================
// Public API
// ============================================

/**
 * Send a generic alert to Discord with a rich embed.
 */
export async function sendDiscordAlert(opts: {
  level: DiscordAlertLevel
  title: string
  message: string
  details?: Record<string, string | number>
  channel?: 'primary' | 'trading'
}): Promise<boolean> {
  const webhookUrl = getWebhookUrl(opts.channel)
  if (!webhookUrl) {
    logger.warn('[Discord] No webhook URL configured')
    return false
  }

  const fields: DiscordEmbedField[] = []
  if (opts.details) {
    for (const [k, v] of Object.entries(opts.details)) {
      fields.push({ name: k, value: String(v), inline: true })
    }
  }

  const embed: DiscordEmbed = {
    title: `${LEVEL_EMOJI[opts.level]} ${opts.title}`,
    description: opts.message,
    color: LEVEL_COLORS[opts.level],
    fields: fields.length > 0 ? fields : undefined,
    footer: { text: 'Arena Trading Platform' },
    timestamp: new Date().toISOString(),
  }

  return sendToWebhook(webhookUrl, { embeds: [embed] })
}

/**
 * Send a rank change alert for a trader — used by the alert pipeline.
 */
export async function sendRankChangeAlert(opts: {
  traderHandle: string
  platform: string
  platformName: string
  oldRank: number
  newRank: number
  arenaScore: number | null
  roi: number | null
  period: string
  profileUrl: string
}): Promise<boolean> {
  const webhookUrl = getWebhookUrl('trading')
  if (!webhookUrl) return false

  const rankDelta = opts.oldRank - opts.newRank
  const direction = rankDelta > 0 ? '\u{2B06}\u{FE0F}' : '\u{2B07}\u{FE0F}'  // up/down arrow
  const color = rankDelta > 0 ? 0x00cc66 : 0xff4444

  const fields: DiscordEmbedField[] = [
    { name: 'Rank', value: `#${opts.oldRank} \u{2192} #${opts.newRank} (${rankDelta > 0 ? '+' : ''}${rankDelta})`, inline: true },
    { name: 'Exchange', value: opts.platformName, inline: true },
    { name: 'Period', value: opts.period, inline: true },
  ]

  if (opts.arenaScore != null) {
    fields.push({ name: 'Arena Score', value: opts.arenaScore.toFixed(1), inline: true })
  }
  if (opts.roi != null) {
    fields.push({ name: 'ROI', value: `${opts.roi >= 0 ? '+' : ''}${opts.roi.toFixed(2)}%`, inline: true })
  }

  const embed: DiscordEmbed = {
    author: {
      name: `${opts.traderHandle} ${direction}`,
      url: opts.profileUrl,
    },
    title: `Rank Change: #${opts.oldRank} \u{2192} #${opts.newRank}`,
    color,
    fields,
    footer: { text: `Arena \u{00B7} ${opts.platformName}` },
    timestamp: new Date().toISOString(),
    url: opts.profileUrl,
  }

  return sendToWebhook(webhookUrl, { embeds: [embed] })
}

/**
 * Send a "new top trader" alert — when a trader enters the top N.
 */
export async function sendNewTopTraderAlert(opts: {
  traderHandle: string
  platform: string
  platformName: string
  rank: number
  arenaScore: number | null
  roi: number | null
  pnl: number | null
  period: string
  profileUrl: string
}): Promise<boolean> {
  const webhookUrl = getWebhookUrl('trading')
  if (!webhookUrl) return false

  const fields: DiscordEmbedField[] = [
    { name: 'Rank', value: `#${opts.rank}`, inline: true },
    { name: 'Exchange', value: opts.platformName, inline: true },
    { name: 'Period', value: opts.period, inline: true },
  ]

  if (opts.arenaScore != null) {
    fields.push({ name: 'Arena Score', value: opts.arenaScore.toFixed(1), inline: true })
  }
  if (opts.roi != null) {
    fields.push({ name: 'ROI', value: `${opts.roi >= 0 ? '+' : ''}${opts.roi.toFixed(2)}%`, inline: true })
  }
  if (opts.pnl != null) {
    const pnlStr = opts.pnl >= 1e6 ? `$${(opts.pnl / 1e6).toFixed(2)}M` :
                   opts.pnl >= 1e3 ? `$${(opts.pnl / 1e3).toFixed(1)}K` :
                   `$${opts.pnl.toFixed(2)}`
    fields.push({ name: 'PnL', value: pnlStr, inline: true })
  }

  const embed: DiscordEmbed = {
    title: `\u{1F31F} New Top Trader: ${opts.traderHandle}`,
    description: `${opts.traderHandle} has entered the top ${opts.rank <= 10 ? '10' : '50'} on ${opts.platformName}!`,
    color: 0xffd700, // gold
    fields,
    footer: { text: `Arena \u{00B7} ${opts.platformName}` },
    timestamp: new Date().toISOString(),
    url: opts.profileUrl,
  }

  return sendToWebhook(webhookUrl, { embeds: [embed] })
}

/**
 * Send a pipeline status alert to Discord.
 */
export async function sendDiscordPipelineAlert(opts: {
  level: DiscordAlertLevel
  title: string
  successRate: number
  failedPlatforms: string[]
  stalePlatforms: string[]
}): Promise<boolean> {
  const webhookUrl = getWebhookUrl('primary')
  if (!webhookUrl) return false

  const fields: DiscordEmbedField[] = [
    { name: 'Success Rate', value: `${opts.successRate.toFixed(1)}%`, inline: true },
  ]

  if (opts.failedPlatforms.length > 0) {
    fields.push({
      name: 'Failed',
      value: opts.failedPlatforms.join(', '),
      inline: false,
    })
  }

  if (opts.stalePlatforms.length > 0) {
    fields.push({
      name: 'Stale',
      value: opts.stalePlatforms.join(', '),
      inline: false,
    })
  }

  const embed: DiscordEmbed = {
    title: `${LEVEL_EMOJI[opts.level]} ${opts.title}`,
    color: LEVEL_COLORS[opts.level],
    fields,
    footer: { text: 'Arena Pipeline Monitor' },
    timestamp: new Date().toISOString(),
  }

  return sendToWebhook(webhookUrl, { embeds: [embed] })
}

/**
 * Send a daily digest summary to Discord.
 */
export async function sendDiscordDailyDigest(opts: {
  traderCount: number
  exchangeCount: number
  pipelineSuccessRate: number
  alertCount24h: number
  topTraders: Array<{ handle: string; platform: string; score: number; rank: number }>
}): Promise<boolean> {
  const webhookUrl = getWebhookUrl('primary')
  if (!webhookUrl) return false

  const statusEmoji = opts.pipelineSuccessRate >= 95 ? '\u{1F7E2}' :
                      opts.pipelineSuccessRate >= 80 ? '\u{1F7E1}' : '\u{1F534}'

  const topList = opts.topTraders
    .map((t, i) => `${i + 1}. **${t.handle}** (${t.platform}) — ${t.score.toFixed(1)}pts #${t.rank}`)
    .join('\n')

  const embed: DiscordEmbed = {
    title: '\u{1F4CA} Arena Daily Digest',
    color: 0x5865f2,
    fields: [
      { name: 'Pipeline', value: `${statusEmoji} ${opts.pipelineSuccessRate.toFixed(1)}%`, inline: true },
      { name: 'Traders', value: opts.traderCount.toLocaleString(), inline: true },
      { name: 'Exchanges', value: String(opts.exchangeCount), inline: true },
      { name: 'Alerts (24h)', value: String(opts.alertCount24h), inline: true },
    ],
    footer: { text: 'Arena Trading Platform' },
    timestamp: new Date().toISOString(),
  }

  if (topList) {
    embed.fields!.push({
      name: '\u{1F3C6} Top Performers',
      value: topList,
      inline: false,
    })
  }

  return sendToWebhook(webhookUrl, { embeds: [embed] })
}
