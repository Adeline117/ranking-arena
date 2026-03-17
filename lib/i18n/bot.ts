/**
 * Bot-specific i18n messages for Telegram and Discord bots.
 * Separate from the main i18n system to keep bundle size small.
 */

export type BotLang = 'en' | 'zh'

const messages: Record<BotLang, Record<string, string>> = {
  en: {
    // Command responses
    rank: 'Rank',
    score: 'Score',
    period: 'Period',
    viewProfile: 'View',
    viewMore: 'View more',

    // /rank
    rankUsage: 'Usage: /rank <trader name or ID>\nExample: /rank CryptoKing',
    traderNotFound: 'No trader found matching "{query}". Try a different name or ID.',

    // /top
    topTradersOn: 'Top 10 Traders on',
    topTradersGlobal: 'Top 10 Traders (Global)',
    exchangeNotFound: 'Exchange "{exchange}" not found.',
    availableExchanges: 'Available exchanges',
    noTradersFound: 'No ranked traders found for this exchange.',

    // /follow
    followUsage: 'Usage: /follow <trader name>\nExample: /follow CryptoKing',
    followSuccess: 'Now following {handle} on {platform}. You will receive alerts when their rank changes significantly.',
    followError: 'Failed to set up alert. Please try again later.',

    // /unfollow
    unfollowUsage: 'Usage: /unfollow <trader name>\nExample: /unfollow CryptoKing',
    unfollowSuccess: 'Unfollowed {handle}. You will no longer receive alerts for this trader.',
    unfollowError: 'Failed to unfollow. Please try again later.',
    noSubscriptions: 'You have no active subscriptions.',
    subscriptionNotFound: 'No subscription found matching "{query}". Use /follow to see your list.',

    // /price
    priceUsage: 'Usage: /price <symbol>\nExample: /price BTC',
    priceLabel: 'Price',
    volumeLabel: 'Volume (24h)',
    marketCapLabel: 'Market Cap',
    priceNotFound: 'Price data not found for {symbol}. Try BTC, ETH, SOL, etc.',
    priceError: 'Failed to fetch price data. Please try again later.',

    // /stats
    statsTitle: 'Arena Platform Stats',
    totalTraders: 'Ranked Traders',
    activeExchanges: 'Active Exchanges',
    scoringPeriods: 'Scoring Periods',
    exchangeList: 'Exchanges',
    website: 'Website',

    // /help
    commands: 'Commands',
    helpRank: 'Look up a trader\'s ranking and score',
    helpTop: 'Show top 10 traders (optionally filter by exchange)',
    helpFollow: 'Subscribe to rank change alerts for a trader',
    helpUnfollow: 'Unsubscribe from a trader\'s alerts',
    helpPrice: 'Quick crypto price check',
    helpStats: 'Platform statistics',
    helpHelp: 'Show this help message',

    // Errors
    genericError: 'Something went wrong. Please try again later.',
  },
  zh: {
    rank: '排名',
    score: '评分',
    period: '周期',
    viewProfile: '查看',
    viewMore: '查看更多',

    rankUsage: '用法: /rank <交易员名称或ID>\n示例: /rank CryptoKing',
    traderNotFound: '未找到匹配 "{query}" 的交易员，请尝试其他名称或ID。',

    topTradersOn: 'Top 10 交易员 —',
    topTradersGlobal: 'Top 10 交易员（全平台）',
    exchangeNotFound: '未找到交易所 "{exchange}"。',
    availableExchanges: '可用交易所',
    noTradersFound: '该交易所暂无排名交易员。',

    followUsage: '用法: /follow <交易员名称>\n示例: /follow CryptoKing',
    followSuccess: '已关注 {handle}（{platform}）。当排名发生显著变化时将收到提醒。',
    followError: '关注设置失败，请稍后重试。',

    unfollowUsage: '用法: /unfollow <交易员名称>\n示例: /unfollow CryptoKing',
    unfollowSuccess: '已取消关注 {handle}，不再接收该交易员的提醒。',
    unfollowError: '取消关注失败，请稍后重试。',
    noSubscriptions: '你没有任何活跃的订阅。',
    subscriptionNotFound: '未找到匹配 "{query}" 的订阅。使用 /follow 查看列表。',

    priceUsage: '用法: /price <代币符号>\n示例: /price BTC',
    priceLabel: '价格',
    volumeLabel: '24h成交额',
    marketCapLabel: '市值',
    priceNotFound: '未找到 {symbol} 的价格数据，请尝试 BTC、ETH、SOL 等。',
    priceError: '获取价格失败，请稍后重试。',

    statsTitle: 'Arena 平台统计',
    totalTraders: '排名交易员',
    activeExchanges: '活跃交易所',
    scoringPeriods: '评分周期',
    exchangeList: '交易所列表',
    website: '网站',

    commands: '命令列表',
    helpRank: '查询交易员排名和评分',
    helpTop: '查看 Top 10 交易员（可按交易所筛选）',
    helpFollow: '订阅交易员排名变动提醒',
    helpUnfollow: '取消订阅',
    helpPrice: '快速查询加密货币价格',
    helpStats: '平台统计数据',
    helpHelp: '显示此帮助消息',

    genericError: '出现错误，请稍后重试。',
  },
}

/**
 * Get a bot message with optional template variable replacement.
 */
export function botMessages(lang: BotLang, key: string, vars?: Record<string, string | number>): string {
  let msg = messages[lang]?.[key] || messages.en[key] || key
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      msg = msg.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
    }
  }
  return msg
}
