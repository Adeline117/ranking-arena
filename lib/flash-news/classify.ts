/**
 * Flash-news content classifier (U7-3, extracted U7-5).
 *
 * Root cause this solves: category was 100% hardcoded per RSS source, so every
 * item from a given feed got the same category regardless of what the article
 * was about (CryptoBriefing → everything "defi"; generic feeds dumped funerals /
 * 世界杯 / 台海 into "defi"). The classifier below routes on title+content
 * keywords and OVERRIDES the source's hardcoded category. Output is restricted
 * to the 5 canonical categories the UI knows (see FlashNewsPageClient
 * CATEGORY_DISPLAY_MAP): btc_eth | altcoin | defi | macro | exchange. We never
 * emit a value the display map doesn't recognize (no 'nft').
 *
 * Extracted from app/api/cron/flash-news-fetch/route.ts so the cron + the
 * backfill script (scripts/backfill-flash-news-classify.mjs) share one source of
 * truth instead of duplicating keyword tables.
 */

export type CanonicalCategory = 'btc_eth' | 'altcoin' | 'defi' | 'macro' | 'exchange'

// Keyword tables. Matched case-insensitively as substrings against `title + content`.
// zh keywords included because generic feeds surface Chinese-language items.
export const CATEGORY_KEYWORDS: Record<CanonicalCategory, string[]> = {
  // Exchange-specific: named CEX/DEX + exchange actions (listing / reserves / delisting)
  exchange: [
    'binance',
    'okx',
    'coinbase',
    'bybit',
    'kraken',
    'kucoin',
    'bitget',
    'mexc',
    'gate.io',
    'gate io',
    'htx',
    'huobi',
    'upbit',
    'bitfinex',
    'crypto.com',
    'bitstamp',
    'bithumb',
    'gemini exchange',
    'listing',
    'will list',
    'lists ',
    'delisting',
    'delist',
    'proof of reserve',
    'proof-of-reserve',
    'reserves',
    '上币',
    '上线交易',
    '下架',
    '储备证明',
    '交易所',
  ],
  // Macro / regulation
  macro: [
    'fed',
    'federal reserve',
    'interest rate',
    'rate cut',
    'rate hike',
    'inflation',
    'cpi',
    'gdp',
    'recession',
    'regulation',
    'regulatory',
    'regulator',
    ' sec ',
    'sec ',
    'cftc',
    'lawsuit',
    'sues',
    'court',
    'congress',
    'senate',
    'treasury',
    'tariff',
    'policy',
    'central bank',
    'macro',
    '监管',
    '宏观',
    '美联储',
    '利率',
    '通胀',
    '政策',
    '法案',
  ],
  // DeFi
  defi: [
    'defi',
    'tvl',
    'lending',
    'dex ',
    'aave',
    'uniswap',
    'yield',
    'liquidity pool',
    'staking',
    'restaking',
    'eigenlayer',
    'curve finance',
    'compound',
    'makerdao',
    'lido',
    'pendle',
    'protocol',
    'stablecoin',
    'usdt',
    'usdc',
    'dai',
    '去中心化金融',
    '质押',
    '流动性',
  ],
  // BTC / ETH majors
  btc_eth: [
    'bitcoin',
    'btc',
    'ethereum',
    ' eth',
    'eth ',
    'ether',
    'satoshi',
    'halving',
    'vitalik',
    'spot etf',
    'etf',
    '比特币',
    '以太坊',
  ],
  // Named altcoins / memecoins
  altcoin: [
    'solana',
    ' sol ',
    'cardano',
    'ada ',
    'ripple',
    'xrp',
    'dogecoin',
    'doge',
    'shiba',
    'avalanche',
    'avax',
    'polkadot',
    'polygon',
    'matic',
    'chainlink',
    'link ',
    'litecoin',
    'tron',
    'ton ',
    'sui ',
    'aptos',
    'memecoin',
    'meme coin',
    'altcoin',
    'bnb',
    'pepe',
    'bonk',
    '山寨',
  ],
}

// Tie-break priority (most specific / salient first).
export const CATEGORY_PRIORITY: CanonicalCategory[] = [
  'exchange',
  'macro',
  'defi',
  'altcoin',
  'btc_eth',
]

// Broad crypto vocabulary — presence of ANY term marks the item as crypto-related.
// CORE crypto vocabulary = unambiguous crypto signals. Deliberately EXCLUDES the
// `macro` category keywords (fed / rate / inflation / sec / china / tension /
// election …): those are legitimate for classifying crypto-adjacent macro news,
// but on their OWN they also match pure geopolitics/economics ("China expels
// Japanese ship", "regional tensions") — which generic RSS feeds dump in. Using
// only the non-macro vocabulary as the crypto-relevance signal drops that junk
// while keeping anything that actually names a coin/protocol/exchange/etc.
export const CORE_CRYPTO_TERMS = [
  'crypto',
  'bitcoin',
  'btc',
  'ethereum',
  'eth',
  'blockchain',
  'token',
  'coin',
  'defi',
  'nft',
  'web3',
  'stablecoin',
  'altcoin',
  'wallet',
  'exchange',
  'mining',
  'miner',
  'satoshi',
  'onchain',
  'on-chain',
  'dao',
  'airdrop',
  'staking',
  // crypto-adjacent concepts a bare coin/protocol list misses (prediction
  // markets are on-chain; CBDCs & tokenized perps are crypto news) — keep them.
  'polymarket',
  'kalshi',
  'prediction market',
  'perpetual',
  'cbdc',
  'digital euro',
  'digital ruble',
  'digital yuan',
  'tokeniz',
  ...CATEGORY_KEYWORDS.btc_eth,
  ...CATEGORY_KEYWORDS.altcoin,
  ...CATEGORY_KEYWORDS.defi,
  ...CATEGORY_KEYWORDS.exchange,
  '加密',
  '币',
  '区块链',
  '链上',
  '钱包',
]

// Kept for any external callers; superset that also treats macro keywords as
// crypto-relevant (used only where macro-adjacency should count).
export const CRYPTO_TERMS = [...CORE_CRYPTO_TERMS, ...CATEGORY_KEYWORDS.macro, 'ledger']

// Obvious off-topic markers from generic/aggregator feeds.
export const NON_CRYPTO_MARKERS = [
  'funeral',
  'obituary',
  'world cup',
  'football',
  'soccer',
  'nba',
  'super bowl',
  'oscar',
  'grammy',
  'celebrity',
  'royal family',
  'election',
  'weather forecast',
  'hurricane',
  'earthquake',
  'wildfire',
  'recipe',
  'movie review',
  'box office',
  '葬礼',
  '世界杯',
  '台海',
  '选举',
  '足球',
  '奥斯卡',
]

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function countMatches(haystack: string, keywords: string[]): number {
  let n = 0
  for (const kw of keywords) {
    const k = kw.trim()
    if (!k) continue
    // ASCII alnum keywords use word-boundary matching so short tokens (eth, btc)
    // don't fire inside longer words (ethereum, bitcoin) — that substring bug made
    // any DeFi headline mentioning "Ethereum" score btc_eth=3 (ethereum+eth+ether)
    // and outrank defi. CJK keywords / multi-word phrases keep substring matching.
    if (/^[\x00-\x7f]+$/.test(k) && /[a-z0-9]/i.test(k)) {
      const re = new RegExp(`(^|[^a-z0-9])${escapeRegExp(k.toLowerCase())}([^a-z0-9]|$)`)
      if (re.test(haystack)) n++
    } else if (haystack.includes(k)) {
      n++
    }
  }
  return n
}

/** True if the item looks non-crypto and should be dropped (conservative). */
export function isNonCrypto(title: string, content: string | null): boolean {
  const hay = `${title} ${content || ''}`.toLowerCase()
  // Drop only when BOTH: (a) no genuine crypto signal (core vocab excludes bare
  // macro terms, so geopolitics that only matched fed/rate/china no longer counts
  // as crypto) AND (b) an explicit off-topic marker fires. The AND keeps this
  // safe: real crypto news that a keyword list can't enumerate (THORChain, Base,
  // digital ruble, "perpetuals"…) has no off-topic marker → never dropped. Only
  // unmistakable junk (funerals / World Cup / entertainment with zero crypto
  // signal) is removed. Purely-macro items with no marker are kept (belong under
  // the macro category).
  const hasCrypto = CORE_CRYPTO_TERMS.some((t) => hay.includes(t))
  if (hasCrypto) return false
  return NON_CRYPTO_MARKERS.some((m) => hay.includes(m))
}

/**
 * Classify by title+content keywords. Returns a canonical category, or the
 * source's hardcoded fallback if nothing matches. Highest keyword-hit count
 * wins; ties broken by CATEGORY_PRIORITY.
 */
export function classifyCategory(
  title: string,
  content: string | null,
  fallback: CanonicalCategory
): CanonicalCategory {
  const hay = `${title} ${content || ''}`.toLowerCase()
  let best: CanonicalCategory | null = null
  let bestScore = 0
  for (const cat of CATEGORY_PRIORITY) {
    const score = countMatches(hay, CATEGORY_KEYWORDS[cat])
    // strict > keeps priority order on ties (first in CATEGORY_PRIORITY wins)
    if (score > bestScore) {
      bestScore = score
      best = cat
    }
  }
  return bestScore > 0 && best ? best : fallback
}
