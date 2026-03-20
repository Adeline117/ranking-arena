/**
 * Telegram Community Bot Service
 *
 * Handles incoming Telegram bot commands for the Arena trading community.
 * Uses raw Telegram Bot API via fetch() — no external framework.
 *
 * Commands:
 *   /rank <trader>   - Look up a trader's ranking and score
 *   /top <exchange>  - Show top 10 traders on an exchange
 *   /follow <trader> - Subscribe to rank change alerts
 *   /unfollow <trader> - Unsubscribe
 *   /price <symbol>  - Quick price check (CCXT)
 *   /stats           - Platform stats
 *   /help            - Command list
 */

import { getSupabaseAdmin } from '@/lib/supabase/server'
import { getLeaderboard, searchTraders } from '@/lib/data/unified'
import { EXCHANGE_CONFIG, EXCHANGE_NAMES } from '@/lib/constants/exchanges'
import { logger } from '@/lib/logger'
import { botMessages, type BotLang } from '@/lib/i18n/bot'
import { BASE_URL } from '@/lib/constants/urls'

// ============================================
// Types
// ============================================

interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
}

interface TelegramMessage {
  message_id: number
  from?: { id: number; first_name: string; username?: string; language_code?: string }
  chat: { id: number; type: string }
  text?: string
  date: number
}

interface TelegramSendMessageParams {
  chat_id: number | string
  text: string
  parse_mode?: 'HTML' | 'Markdown' | 'MarkdownV2'
  disable_web_page_preview?: boolean
  reply_to_message_id?: number
}

// ============================================
// Telegram API helpers
// ============================================

const TELEGRAM_API = 'https://api.telegram.org/bot'

function getBotToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN not configured')
  return token
}

async function sendMessage(params: TelegramSendMessageParams): Promise<boolean> {
  try {
    const token = getBotToken()
    const res = await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...params,
        parse_mode: params.parse_mode || 'HTML',
        disable_web_page_preview: params.disable_web_page_preview ?? true,
      }),
    })
    if (!res.ok) {
      const body = await res.text()
      logger.error(`[TelegramBot] sendMessage failed: ${res.status} ${body}`)
      return false
    }
    return true
  } catch (err) {
    logger.error('[TelegramBot] sendMessage error:', err)
    return false
  }
}

// ============================================
// Language detection
// ============================================

function detectLang(languageCode?: string): BotLang {
  if (!languageCode) return 'en'
  if (languageCode.startsWith('zh')) return 'zh'
  return 'en'
}

// ============================================
// Command handlers
// ============================================

async function handleRank(chatId: number, args: string, lang: BotLang): Promise<void> {
  const query = args.trim()
  if (!query) {
    await sendMessage({ chat_id: chatId, text: botMessages(lang, 'rankUsage') })
    return
  }

  const supabase = getSupabaseAdmin()
  const traders = await searchTraders(supabase, { query, limit: 3 })

  if (!traders || traders.length === 0) {
    await sendMessage({ chat_id: chatId, text: botMessages(lang, 'traderNotFound', { query }) })
    return
  }

  const lines: string[] = []
  for (const t of traders) {
    const exchangeName = EXCHANGE_CONFIG[t.platform as keyof typeof EXCHANGE_CONFIG]?.name || t.platform
    const score = t.arenaScore != null ? t.arenaScore.toFixed(1) : 'N/A'
    const rank = t.rank != null ? `#${t.rank}` : 'N/A'
    const roi = t.roi != null ? `${t.roi >= 0 ? '+' : ''}${t.roi.toFixed(2)}%` : 'N/A'
    const pnl = t.pnl != null ? `$${formatNumber(t.pnl)}` : 'N/A'
    const period = t.period || '90D'

    lines.push(
      `<b>${t.handle || t.traderKey}</b> (${exchangeName})`,
      `  ${botMessages(lang, 'rank')}: ${rank} | ${botMessages(lang, 'score')}: ${score}`,
      `  ROI: ${roi} | PnL: ${pnl}`,
      `  ${botMessages(lang, 'period')}: ${period}`,
      `  ${botMessages(lang, 'viewProfile')}: ${BASE_URL}/trader/${t.platform}/${t.traderKey}`,
      ''
    )
  }

  await sendMessage({ chat_id: chatId, text: lines.join('\n') })
}

async function handleTop(chatId: number, args: string, lang: BotLang): Promise<void> {
  const exchangeArg = args.trim().toLowerCase()

  // Resolve exchange name to source key
  let platform: string | undefined
  if (exchangeArg) {
    // Try exact match first
    if (EXCHANGE_CONFIG[exchangeArg as keyof typeof EXCHANGE_CONFIG]) {
      platform = exchangeArg
    } else {
      // Fuzzy match by display name
      const entry = Object.entries(EXCHANGE_CONFIG).find(
        ([key, config]) =>
          config.name.toLowerCase() === exchangeArg ||
          key.replace(/_/g, '').includes(exchangeArg.replace(/[_\s.-]/g, ''))
      )
      if (entry) platform = entry[0]
    }

    if (!platform) {
      const exchanges = Object.entries(EXCHANGE_CONFIG)
        .filter(([, c]) => c.reliability >= 60)
        .map(([k, c]) => `  <code>${k}</code> — ${c.name}`)
        .slice(0, 20)
        .join('\n')
      await sendMessage({
        chat_id: chatId,
        text: `${botMessages(lang, 'exchangeNotFound', { exchange: exchangeArg })}\n\n${botMessages(lang, 'availableExchanges')}:\n${exchanges}`,
      })
      return
    }
  }

  const supabase = getSupabaseAdmin()
  const { traders } = await getLeaderboard(supabase, {
    platform,
    period: '90D',
    limit: 10,
    sortBy: 'rank',
  })

  if (!traders || traders.length === 0) {
    await sendMessage({ chat_id: chatId, text: botMessages(lang, 'noTradersFound') })
    return
  }

  const title = platform
    ? `${botMessages(lang, 'topTradersOn')} ${EXCHANGE_CONFIG[platform as keyof typeof EXCHANGE_CONFIG]?.name || platform}`
    : botMessages(lang, 'topTradersGlobal')

  const lines = [`<b>${title}</b> (90D)\n`]
  for (const t of traders) {
    const exchangeName = !platform
      ? ` [${EXCHANGE_CONFIG[t.platform as keyof typeof EXCHANGE_CONFIG]?.name || t.platform}]`
      : ''
    const score = t.arenaScore != null ? t.arenaScore.toFixed(1) : '-'
    const roi = t.roi != null ? `${t.roi >= 0 ? '+' : ''}${t.roi.toFixed(1)}%` : '-'
    const rank = t.rank != null ? `${t.rank}` : '-'

    lines.push(
      `${rank}. <b>${t.handle || t.traderKey.slice(0, 10)}</b>${exchangeName}  ${score}pts  ${roi}`
    )
  }

  lines.push(`\n${botMessages(lang, 'viewMore')}: ${BASE_URL}/rankings${platform ? `/${platform}` : ''}`)

  await sendMessage({ chat_id: chatId, text: lines.join('\n') })
}

async function handleFollow(chatId: number, args: string, userId: number, lang: BotLang): Promise<void> {
  const query = args.trim()
  if (!query) {
    await sendMessage({ chat_id: chatId, text: botMessages(lang, 'followUsage') })
    return
  }

  const supabase = getSupabaseAdmin()
  const traders = await searchTraders(supabase, { query, limit: 1 })

  if (!traders || traders.length === 0) {
    await sendMessage({ chat_id: chatId, text: botMessages(lang, 'traderNotFound', { query }) })
    return
  }

  const trader = traders[0]
  const traderId = `${trader.platform}:${trader.traderKey}`

  // Store follow subscription in Supabase
  const { error } = await supabase
    .from('bot_subscriptions')
    .upsert(
      {
        platform_type: 'telegram',
        platform_user_id: String(userId),
        chat_id: String(chatId),
        trader_id: traderId,
        trader_handle: trader.handle || trader.traderKey,
        trader_platform: trader.platform,
        enabled: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'platform_type,platform_user_id,trader_id' }
    )

  if (error) {
    logger.error('[TelegramBot] Follow upsert error:', error)
    await sendMessage({ chat_id: chatId, text: botMessages(lang, 'followError') })
    return
  }

  await sendMessage({
    chat_id: chatId,
    text: botMessages(lang, 'followSuccess', {
      handle: trader.handle || trader.traderKey,
      platform: EXCHANGE_CONFIG[trader.platform as keyof typeof EXCHANGE_CONFIG]?.name || trader.platform,
    }),
  })
}

async function handleUnfollow(chatId: number, args: string, userId: number, lang: BotLang): Promise<void> {
  const query = args.trim()
  if (!query) {
    await sendMessage({ chat_id: chatId, text: botMessages(lang, 'unfollowUsage') })
    return
  }

  const supabase = getSupabaseAdmin()

  // Try to find by trader handle or ID in subscriptions
  const { data: subs } = await supabase
    .from('bot_subscriptions')
    .select('id, trader_id, trader_handle')
    .eq('platform_type', 'telegram')
    .eq('platform_user_id', String(userId))
    .eq('enabled', true)

  if (!subs || subs.length === 0) {
    await sendMessage({ chat_id: chatId, text: botMessages(lang, 'noSubscriptions') })
    return
  }

  // Find matching subscription
  const match = subs.find(
    (s) =>
      s.trader_handle?.toLowerCase().includes(query.toLowerCase()) ||
      s.trader_id?.toLowerCase().includes(query.toLowerCase())
  )

  if (!match) {
    await sendMessage({ chat_id: chatId, text: botMessages(lang, 'subscriptionNotFound', { query }) })
    return
  }

  const { error } = await supabase
    .from('bot_subscriptions')
    .update({ enabled: false, updated_at: new Date().toISOString() })
    .eq('id', match.id)

  if (error) {
    logger.error('[TelegramBot] Unfollow error:', error)
    await sendMessage({ chat_id: chatId, text: botMessages(lang, 'unfollowError') })
    return
  }

  await sendMessage({
    chat_id: chatId,
    text: botMessages(lang, 'unfollowSuccess', { handle: match.trader_handle || query }),
  })
}

async function handlePrice(chatId: number, args: string, lang: BotLang): Promise<void> {
  const symbol = args.trim().toUpperCase()
  if (!symbol) {
    await sendMessage({ chat_id: chatId, text: botMessages(lang, 'priceUsage') })
    return
  }

  try {
    // Use CoinGecko free API for price data (no auth needed)
    const cgId = symbolToCoinGeckoId(symbol)
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${cgId}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true&include_market_cap=true`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) }
    )

    if (!res.ok) {
      await sendMessage({ chat_id: chatId, text: botMessages(lang, 'priceNotFound', { symbol }) })
      return
    }

    const data = await res.json()
    const priceData = data[cgId]

    if (!priceData || priceData.usd == null) {
      await sendMessage({ chat_id: chatId, text: botMessages(lang, 'priceNotFound', { symbol }) })
      return
    }

    const price = priceData.usd
    const change24h = priceData.usd_24h_change
    const volume = priceData.usd_24h_vol
    const marketCap = priceData.usd_market_cap

    const changeStr = change24h != null ? `${change24h >= 0 ? '+' : ''}${change24h.toFixed(2)}%` : 'N/A'
    const changeIcon = change24h != null ? (change24h >= 0 ? '\u{1F7E2}' : '\u{1F534}') : ''

    const lines = [
      `${changeIcon} <b>${symbol}/USD</b>`,
      `${botMessages(lang, 'priceLabel')}: $${formatPrice(price)}`,
      `24h: ${changeStr}`,
    ]

    if (volume != null) lines.push(`${botMessages(lang, 'volumeLabel')}: $${formatNumber(volume)}`)
    if (marketCap != null) lines.push(`${botMessages(lang, 'marketCapLabel')}: $${formatNumber(marketCap)}`)

    await sendMessage({ chat_id: chatId, text: lines.join('\n') })
  } catch (err) {
    logger.error('[TelegramBot] Price fetch error:', err)
    await sendMessage({ chat_id: chatId, text: botMessages(lang, 'priceError') })
  }
}

async function handleStats(chatId: number, lang: BotLang): Promise<void> {
  const supabase = getSupabaseAdmin()

  // Get trader count and exchange count from leaderboard_ranks
  const [traderResult, exchangeResult] = await Promise.all([
    supabase
      .from('leaderboard_ranks')
      .select('source_trader_id', { count: 'exact', head: true })
      .eq('season_id', '90D'),
    supabase
      .from('leaderboard_ranks')
      .select('source')
      .eq('season_id', '90D'),
  ])

  const traderCount = traderResult.count ?? 0

  // Count unique exchanges
  const exchanges = new Set((exchangeResult.data || []).map((r: { source: string }) => r.source))
  const exchangeCount = exchanges.size

  // Active exchange list
  const activeExchanges = Array.from(exchanges)
    .map((s) => EXCHANGE_CONFIG[s as keyof typeof EXCHANGE_CONFIG]?.name || s)
    .sort()

  const lines = [
    `<b>${botMessages(lang, 'statsTitle')}</b>\n`,
    `${botMessages(lang, 'totalTraders')}: ${traderCount.toLocaleString()}`,
    `${botMessages(lang, 'activeExchanges')}: ${exchangeCount}`,
    `${botMessages(lang, 'scoringPeriods')}: 7D / 30D / 90D`,
    `\n${botMessages(lang, 'exchangeList')}:`,
    activeExchanges.map((e) => `  ${e}`).join('\n'),
    `\n${botMessages(lang, 'website')}: ${BASE_URL}`,
  ]

  await sendMessage({ chat_id: chatId, text: lines.join('\n') })
}

async function handleHelp(chatId: number, lang: BotLang): Promise<void> {
  const text = [
    `<b>Arena Bot ${botMessages(lang, 'commands')}</b>\n`,
    `/rank &lt;name&gt; — ${botMessages(lang, 'helpRank')}`,
    `/top [exchange] — ${botMessages(lang, 'helpTop')}`,
    `/follow &lt;name&gt; — ${botMessages(lang, 'helpFollow')}`,
    `/unfollow &lt;name&gt; — ${botMessages(lang, 'helpUnfollow')}`,
    `/price &lt;symbol&gt; — ${botMessages(lang, 'helpPrice')}`,
    `/stats — ${botMessages(lang, 'helpStats')}`,
    `/help — ${botMessages(lang, 'helpHelp')}`,
    `\n${botMessages(lang, 'website')}: ${BASE_URL}`,
  ].join('\n')

  await sendMessage({ chat_id: chatId, text })
}

// ============================================
// Main dispatcher
// ============================================

export async function handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
  const message = update.message
  if (!message?.text) return

  const chatId = message.chat.id
  const userId = message.from?.id ?? 0
  const text = message.text.trim()
  const lang = detectLang(message.from?.language_code)

  // Parse command
  // Handle "/command@BotName args" format
  const match = text.match(/^\/(\w+)(?:@\w+)?\s*(.*)$/s)
  if (!match) return

  const command = match[1].toLowerCase()
  const args = match[2]

  try {
    switch (command) {
      case 'rank':
        await handleRank(chatId, args, lang)
        break
      case 'top':
        await handleTop(chatId, args, lang)
        break
      case 'follow':
        await handleFollow(chatId, args, userId, lang)
        break
      case 'unfollow':
        await handleUnfollow(chatId, args, userId, lang)
        break
      case 'price':
        await handlePrice(chatId, args, lang)
        break
      case 'stats':
        await handleStats(chatId, lang)
        break
      case 'help':
      case 'start':
        await handleHelp(chatId, lang)
        break
      default:
        // Unknown command — ignore
        break
    }
  } catch (err) {
    logger.error(`[TelegramBot] Error handling /${command}:`, err)
    await sendMessage({
      chat_id: chatId,
      text: botMessages(lang, 'genericError'),
    })
  }
}

// ============================================
// Helpers
// ============================================

function formatNumber(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (abs >= 1e3) return `${(n / 1e3).toFixed(2)}K`
  return n.toFixed(2)
}

function formatPrice(n: number): string {
  if (n >= 1) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  if (n >= 0.01) return n.toFixed(4)
  return n.toFixed(8)
}

/** Map common symbol tickers to CoinGecko IDs */
function symbolToCoinGeckoId(symbol: string): string {
  const map: Record<string, string> = {
    BTC: 'bitcoin',
    ETH: 'ethereum',
    SOL: 'solana',
    BNB: 'binancecoin',
    XRP: 'ripple',
    ADA: 'cardano',
    DOGE: 'dogecoin',
    AVAX: 'avalanche-2',
    DOT: 'polkadot',
    MATIC: 'matic-network',
    POL: 'matic-network',
    LINK: 'chainlink',
    UNI: 'uniswap',
    ATOM: 'cosmos',
    ARB: 'arbitrum',
    OP: 'optimism',
    SUI: 'sui',
    APT: 'aptos',
    SEI: 'sei-network',
    TIA: 'celestia',
    INJ: 'injective-protocol',
    FET: 'fetch-ai',
    NEAR: 'near',
    FIL: 'filecoin',
    RENDER: 'render-token',
    PEPE: 'pepe',
    WIF: 'dogwifcoin',
    SHIB: 'shiba-inu',
    BONK: 'bonk',
    TRX: 'tron',
    TON: 'the-open-network',
    LTC: 'litecoin',
    BCH: 'bitcoin-cash',
    HBAR: 'hedera-hashgraph',
    STX: 'blockstack',
    IMX: 'immutable-x',
    MKR: 'maker',
    AAVE: 'aave',
    CRV: 'curve-dao-token',
    TRUMP: 'official-trump',
  }
  return map[symbol] || symbol.toLowerCase()
}
