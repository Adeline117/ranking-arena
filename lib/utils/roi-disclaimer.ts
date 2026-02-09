/**
 * ROI Disclaimer Utility
 *
 * Provides per-exchange ROI calculation methodology explanations.
 * Each exchange may compute ROI differently — this module documents
 * the known methodology and caveats for transparency.
 *
 * 每个交易所的 ROI 计算方式说明。
 * 各交易所的 ROI 计算逻辑不同，本模块为透明性提供说明。
 */

export type SupportedPlatform =
  | 'binance'
  | 'bybit'
  | 'bitget'
  | 'okx'
  | 'mexc'
  | 'kucoin'
  | 'coinex'
  | 'hyperliquid'
  | 'dydx'
  | 'gmx'
  | 'bitmart'
  | 'phemex'
  | 'htx'
  | 'weex'
  | 'bingx'
  | 'gateio'
  | 'xt'
  | 'gains'
  | 'lbank'
  | 'blofin'
  | 'pionex'
  | 'kwenta'
  | 'mux'

export interface RoiDisclaimer {
  /** English explanation */
  en: string
  /** Chinese explanation */
  zh: string
  /** Whether the ROI is platform-provided or derived */
  source: 'platform' | 'derived' | 'estimated'
  /** Known caveats */
  caveats_en: string[]
  caveats_zh: string[]
}

/**
 * ROI calculation methodology per exchange.
 * 各交易所 ROI 计算方式。
 */
export const ROI_DISCLAIMERS: Record<SupportedPlatform, RoiDisclaimer> = {
  binance: {
    en: 'ROI is provided by Binance Copy Trading API. Calculated as cumulative realized + unrealized PnL divided by the initial invested capital over the selected period.',
    zh: 'ROI 由币安跟单 API 提供。计算方式为：选定周期内的累计已实现 + 未实现盈亏除以初始投入资金。',
    source: 'platform',
    caveats_en: [
      'Includes both realized and unrealized PnL',
      'Funding fees and commissions are deducted',
      'Different from portfolio-level ROI shown on the web UI',
    ],
    caveats_zh: [
      '包含已实现和未实现盈亏',
      '已扣除资金费率和手续费',
      '与网页端显示的组合级 ROI 可能存在差异',
    ],
  },

  bybit: {
    en: 'ROI is provided by Bybit Copy Trading API. Formula: (Total PnL / Starting Equity) × 100%. PnL includes realized gains, funding, and fees.',
    zh: 'ROI 由 Bybit 跟单 API 提供。公式：(总盈亏 / 起始权益) × 100%。盈亏包含已实现收益、资金费率及手续费。',
    source: 'platform',
    caveats_en: [
      'ROI resets if the trader withdraws and re-deposits',
      'Bybit may show different ROI on the mobile app vs web',
    ],
    caveats_zh: [
      '交易员提现后重新入金，ROI 会重置',
      'Bybit 手机端和网页端显示的 ROI 可能不同',
    ],
  },

  bitget: {
    en: 'ROI is provided by Bitget Copy Trading API. Calculated as cumulative PnL over initial margin for the period.',
    zh: 'ROI 由 Bitget 跟单 API 提供。计算方式为选定周期内的累计盈亏除以初始保证金。',
    source: 'platform',
    caveats_en: [
      'Bitget separates futures and spot copy trading ROI',
      'ROI may differ between contract types (USDT-M vs Coin-M)',
    ],
    caveats_zh: [
      'Bitget 的合约跟单和现货跟单 ROI 分开计算',
      '不同合约类型 (USDT 本位 vs 币本位) 的 ROI 可能不同',
    ],
  },

  okx: {
    en: 'ROI is provided by OKX Copy Trading API. Based on cumulative PnL over the period divided by the average equity.',
    zh: 'ROI 由 OKX 跟单 API 提供。基于选定周期内的累计盈亏除以平均权益计算。',
    source: 'platform',
    caveats_en: [
      'OKX uses "accumulated income rate" which factors in deposits/withdrawals',
      'Sub-accounts may have separate ROI calculations',
    ],
    caveats_zh: [
      'OKX 使用"累计收益率"，考虑了出入金影响',
      '子账户可能有独立的 ROI 计算',
    ],
  },

  mexc: {
    en: 'ROI is provided by MEXC Copy Trading API. Calculated as total PnL / total invested capital over the period.',
    zh: 'ROI 由 MEXC 跟单 API 提供。计算方式为总盈亏除以选定周期内的总投入资金。',
    source: 'platform',
    caveats_en: [
      'MEXC ROI may include bonus/subsidy amounts',
    ],
    caveats_zh: [
      'MEXC 的 ROI 可能包含奖励/补贴金额',
    ],
  },

  kucoin: {
    en: 'ROI is provided by KuCoin Copy Trading leaderboard API. Formula and details are not fully documented.',
    zh: 'ROI 由 KuCoin 跟单排行榜 API 提供。具体计算公式未完全公开。',
    source: 'platform',
    caveats_en: [
      'KuCoin does not publicly document their exact ROI formula',
      'Leaderboard ranking may use a different metric than displayed ROI',
    ],
    caveats_zh: [
      'KuCoin 未公开详细的 ROI 计算公式',
      '排行榜排名可能使用与显示 ROI 不同的指标',
    ],
  },

  coinex: {
    en: 'ROI is provided by CoinEx Copy Trading API. Calculated as PnL divided by initial equity.',
    zh: 'ROI 由 CoinEx 跟单 API 提供。计算方式为盈亏除以初始权益。',
    source: 'platform',
    caveats_en: [
      'Limited documentation available for CoinEx ROI methodology',
    ],
    caveats_zh: [
      'CoinEx 的 ROI 计算方法文档有限',
    ],
  },

  hyperliquid: {
    en: 'ROI is derived from on-chain PnL data. Calculated as: PnL / (Current Equity − PnL). Hyperliquid does not provide a native ROI field.',
    zh: 'ROI 根据链上盈亏数据推算。公式：盈亏 / (当前权益 − 盈亏)。Hyperliquid 不提供原生 ROI 字段。',
    source: 'derived',
    caveats_en: [
      'ROI is computed client-side, not provided by Hyperliquid',
      'Starting equity is estimated from current equity minus PnL',
      'Deposits/withdrawals during the period may distort ROI',
      'On-chain data — fully verifiable',
    ],
    caveats_zh: [
      'ROI 为客户端计算，非 Hyperliquid 提供',
      '起始权益通过当前权益减去盈亏估算',
      '期间内的出入金可能导致 ROI 失真',
      '链上数据 — 完全可验证',
    ],
  },

  dydx: {
    en: 'ROI is derived from on-chain PnL data via the dYdX v4 indexer. Formula: PnL / (Current Equity − PnL). dYdX leaderboard ranks by absolute PnL, not ROI.',
    zh: 'ROI 根据 dYdX v4 索引器的链上盈亏数据推算。公式：盈亏 / (当前权益 − 盈亏)。dYdX 排行榜按绝对盈亏排序，而非 ROI。',
    source: 'derived',
    caveats_en: [
      'ROI is computed client-side from PnL and equity',
      'dYdX leaderboard only provides absolute PnL ranking',
      'Starting equity is approximated; deposits/withdrawals may cause inaccuracy',
      'On-chain data — fully verifiable via dYdX v4 chain',
      'API access may require proxy in restricted regions',
    ],
    caveats_zh: [
      'ROI 为客户端根据盈亏和权益计算',
      'dYdX 排行榜仅提供绝对盈亏排名',
      '起始权益为近似值，出入金可能导致不准确',
      '链上数据 — 可通过 dYdX v4 链完全验证',
      '在受限地区访问 API 可能需要代理',
    ],
  },

  gmx: {
    en: 'ROI is derived from on-chain trade data indexed via Subgraph/Dune. Calculated as: Realized PnL / Total Collateral deposited.',
    zh: 'ROI 根据通过 Subgraph/Dune 索引的链上交易数据推算。公式：已实现盈亏 / 存入的总保证金。',
    source: 'derived',
    caveats_en: [
      'GMX does not have a native leaderboard',
      'Data sourced from on-chain events via indexers',
      'ROI calculation depends on collateral tracking accuracy',
    ],
    caveats_zh: [
      'GMX 没有原生排行榜',
      '数据来源于通过索引器获取的链上事件',
      'ROI 计算依赖于保证金追踪的准确性',
    ],
  },

  bitmart: {
    en: 'ROI is provided by BitMart Copy Trading API. Specific formula is not publicly documented.',
    zh: 'ROI 由 BitMart 跟单 API 提供。具体公式未公开。',
    source: 'platform',
    caveats_en: ['Limited public documentation on ROI methodology'],
    caveats_zh: ['ROI 计算方法的公开文档有限'],
  },

  phemex: {
    en: 'ROI is provided by Phemex Copy Trading API. Calculated as cumulative PnL / initial investment.',
    zh: 'ROI 由 Phemex 跟单 API 提供。计算方式为累计盈亏除以初始投资额。',
    source: 'platform',
    caveats_en: ['Phemex ROI may differ between contract and spot'],
    caveats_zh: ['Phemex 合约和现货的 ROI 可能不同'],
  },

  htx: {
    en: 'ROI is provided by HTX (Huobi) Copy Trading API. Based on cumulative PnL over invested capital.',
    zh: 'ROI 由 HTX（火币）跟单 API 提供。基于累计盈亏除以投入资金。',
    source: 'platform',
    caveats_en: ['HTX merged from Huobi — historical data may have gaps'],
    caveats_zh: ['HTX 由火币合并而来 — 历史数据可能不完整'],
  },

  weex: {
    en: 'ROI is provided by WEEX Copy Trading API. Specific calculation details unavailable.',
    zh: 'ROI 由 WEEX 跟单 API 提供。具体计算细节不可用。',
    source: 'platform',
    caveats_en: ['WEEX is a newer exchange with limited documentation'],
    caveats_zh: ['WEEX 为较新交易所，文档有限'],
  },

  bingx: {
    en: 'ROI is provided by BingX Copy Trading API. Calculated as PnL / initial margin for the period.',
    zh: 'ROI 由 BingX 跟单 API 提供。计算方式为盈亏除以选定周期的初始保证金。',
    source: 'platform',
    caveats_en: ['BingX ROI includes funding fees'],
    caveats_zh: ['BingX 的 ROI 包含资金费率'],
  },

  gateio: {
    en: 'ROI is provided by Gate.io Copy Trading API. Based on total return over initial investment.',
    zh: 'ROI 由 Gate.io 跟单 API 提供。基于总回报除以初始投资额。',
    source: 'platform',
    caveats_en: ['Gate.io may show different ROI for different product types'],
    caveats_zh: ['Gate.io 不同产品类型可能显示不同的 ROI'],
  },

  xt: {
    en: 'ROI is provided by XT.COM Copy Trading API. Specific formula is not publicly documented.',
    zh: 'ROI 由 XT.COM 跟单 API 提供。具体公式未公开。',
    source: 'platform',
    caveats_en: ['Limited public documentation'],
    caveats_zh: ['公开文档有限'],
  },

  gains: {
    en: 'ROI is derived from gTrade (Gains Network) on-chain data. Based on trade-level PnL aggregation.',
    zh: 'ROI 根据 gTrade（Gains Network）链上数据推算。基于交易级别的盈亏汇总。',
    source: 'derived',
    caveats_en: ['On-chain data, computed from trade events'],
    caveats_zh: ['链上数据，根据交易事件计算'],
  },

  lbank: {
    en: 'ROI is provided by LBank Copy Trading API. Specific methodology is not publicly documented.',
    zh: 'ROI 由 LBank 跟单 API 提供。具体计算方法未公开。',
    source: 'platform',
    caveats_en: ['Limited public documentation on ROI methodology'],
    caveats_zh: ['ROI 计算方法的公开文档有限'],
  },

  blofin: {
    en: 'ROI is provided by BloFin Copy Trading API. Based on cumulative PnL over invested capital.',
    zh: 'ROI 由 BloFin 跟单 API 提供。基于累计盈亏除以投入资金。',
    source: 'platform',
    caveats_en: ['BloFin is a newer exchange — methodology may evolve'],
    caveats_zh: ['BloFin 为较新交易所 — 计算方法可能变化'],
  },

  pionex: {
    en: 'ROI is provided by Pionex trading bot platform. Based on bot performance metrics.',
    zh: 'ROI 由 Pionex 量化交易平台提供。基于机器人交易表现。',
    source: 'platform',
    caveats_en: ['Pionex specializes in trading bots — ROI reflects automated strategy performance'],
    caveats_zh: ['Pionex 以量化机器人为主 — ROI 反映自动策略表现'],
  },

  kwenta: {
    en: 'ROI is derived from on-chain Kwenta/Synthetix perps trading history.',
    zh: 'ROI 基于链上 Kwenta/Synthetix 永续合约交易历史推导。',
    source: 'derived',
    caveats_en: ['On-chain data — may not capture all fee rebates'],
    caveats_zh: ['链上数据 — 可能未包含所有手续费返还'],
  },

  mux: {
    en: 'ROI is derived from on-chain MUX Protocol trading history.',
    zh: 'ROI 基于链上 MUX Protocol 交易历史推导。',
    source: 'derived',
    caveats_en: ['On-chain aggregator — ROI includes multi-venue execution'],
    caveats_zh: ['链上聚合器 — ROI 包含多场所执行'],
  },

}

/**
 * Get ROI disclaimer for a specific platform.
 * 获取指定平台的 ROI 说明。
 */
export function getRoiDisclaimer(platform: SupportedPlatform): RoiDisclaimer | null {
  return ROI_DISCLAIMERS[platform] ?? null
}

/**
 * Get the ROI explanation text in the specified language.
 * 获取指定语言的 ROI 说明文字。
 */
export function getRoiExplanation(platform: SupportedPlatform, lang: 'en' | 'zh' = 'en'): string {
  const disclaimer = ROI_DISCLAIMERS[platform]
  if (!disclaimer) return lang === 'en' ? 'ROI methodology unknown.' : 'ROI 计算方式未知。'
  return disclaimer[lang]
}

/**
 * Get the ROI caveats in the specified language.
 * 获取指定语言的 ROI 注意事项。
 */
export function getRoiCaveats(platform: SupportedPlatform, lang: 'en' | 'zh' = 'en'): string[] {
  const disclaimer = ROI_DISCLAIMERS[platform]
  if (!disclaimer) return []
  return lang === 'en' ? disclaimer.caveats_en : disclaimer.caveats_zh
}

/**
 * Get all platforms that derive ROI (not platform-provided).
 * 获取所有需要客户端推算 ROI 的平台。
 */
export function getDerivedRoiPlatforms(): SupportedPlatform[] {
  return (Object.entries(ROI_DISCLAIMERS) as [SupportedPlatform, RoiDisclaimer][])
    .filter(([, d]) => d.source !== 'platform')
    .map(([p]) => p)
}

/**
 * General disclaimer shown to all users.
 * 对所有用户展示的通用免责声明。
 */
export const GENERAL_ROI_DISCLAIMER = {
  en: 'ROI figures are sourced from each exchange\'s public API or derived from on-chain data. Different exchanges use different ROI calculation methods. ROI may not account for deposits, withdrawals, or transfer events during the measurement period. Past performance does not guarantee future results. Arena scores normalize ROI across platforms for fair comparison.',
  zh: 'ROI 数据来源于各交易所公开 API 或链上数据推算。不同交易所使用不同的 ROI 计算方法。ROI 可能未考虑测量期间的出入金或转账事件。过往表现不代表未来收益。Arena 评分对各平台的 ROI 进行归一化处理，以便公平比较。',
} as const
