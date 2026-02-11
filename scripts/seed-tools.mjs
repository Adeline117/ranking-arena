/**
 * Seed tools table.
 * Usage: node scripts/seed-tools.mjs
 */

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://iknktzifjdyujdccyhsv.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
)

const TRADING_TOOLS = [
  { name: 'TradingView', name_zh: 'TradingView', website: 'https://www.tradingview.com', description: 'Advanced charting platform', description_zh: '专业图表分析平台', pricing: 'freemium' },
  { name: 'Coinglass', name_zh: 'Coinglass', website: 'https://www.coinglass.com', description: 'Derivatives data & analytics', description_zh: '衍生品数据分析', pricing: 'freemium' },
  { name: 'Dexscreener', name_zh: 'Dexscreener', website: 'https://dexscreener.com', description: 'DEX token pair screener', description_zh: 'DEX代币对筛选器', pricing: 'free' },
  { name: 'DefiLlama', name_zh: 'DefiLlama', website: 'https://defillama.com', description: 'DeFi TVL & analytics', description_zh: 'DeFi锁仓量和分析', pricing: 'free' },
  { name: 'Nansen', name_zh: 'Nansen', website: 'https://www.nansen.ai', description: 'On-chain analytics with smart money tracking', description_zh: '链上分析与聪明钱追踪', pricing: 'paid' },
  { name: 'Arkham', name_zh: 'Arkham', website: 'https://www.arkhamintelligence.com', description: 'Blockchain intelligence platform', description_zh: '区块链情报平台', pricing: 'freemium' },
  { name: 'Dune Analytics', name_zh: 'Dune', website: 'https://dune.com', description: 'Community-powered blockchain analytics', description_zh: '社区驱动的链上数据分析', pricing: 'freemium' },
  { name: 'Glassnode', name_zh: 'Glassnode', website: 'https://glassnode.com', description: 'On-chain market intelligence', description_zh: '链上市场情报', pricing: 'paid' },
  { name: 'Token Terminal', name_zh: 'Token Terminal', website: 'https://tokenterminal.com', description: 'Financial data for crypto protocols', description_zh: '加密协议财务数据', pricing: 'freemium' },
  { name: 'Messari', name_zh: 'Messari', website: 'https://messari.io', description: 'Crypto research & data', description_zh: '加密研究与数据', pricing: 'freemium' },
  { name: 'CoinMarketCap', name_zh: 'CMC', website: 'https://coinmarketcap.com', description: 'Market data aggregator', description_zh: '市场数据聚合器', pricing: 'free' },
  { name: 'CoinGecko', name_zh: 'CoinGecko', website: 'https://www.coingecko.com', description: 'Crypto price tracker', description_zh: '加密价格追踪', pricing: 'free' },
  { name: 'Birdeye', name_zh: 'Birdeye', website: 'https://birdeye.so', description: 'Solana DeFi analytics', description_zh: 'Solana DeFi分析', pricing: 'freemium' },
  { name: 'GMGN', name_zh: 'GMGN', website: 'https://gmgn.ai', description: 'Meme token analytics & smart money', description_zh: 'Meme代币分析与聪明钱', pricing: 'freemium' },
  { name: 'Cielo Finance', name_zh: 'Cielo', website: 'https://cielo.finance', description: 'Wallet tracking & analytics', description_zh: '钱包追踪与分析', pricing: 'freemium' },
  { name: 'Kaito', name_zh: 'Kaito', website: 'https://www.kaito.ai', description: 'AI-powered crypto research', description_zh: 'AI驱动的加密研究', pricing: 'paid' },
  { name: 'Santiment', name_zh: 'Santiment', website: 'https://santiment.net', description: 'Behavior analytics for crypto', description_zh: '加密行为分析', pricing: 'paid' },
  { name: 'CryptoQuant', name_zh: 'CryptoQuant', website: 'https://cryptoquant.com', description: 'On-chain & market data', description_zh: '链上与市场数据', pricing: 'freemium' },
  { name: 'Lookonchain', name_zh: 'Lookonchain', website: 'https://www.lookonchain.com', description: 'On-chain data tracking', description_zh: '链上数据追踪', pricing: 'free' },
  { name: '0xScope', name_zh: '0xScope', website: 'https://www.0xscope.com', description: 'Web3 analytics', description_zh: 'Web3分析平台', pricing: 'freemium' },
  { name: 'Zerion', name_zh: 'Zerion', website: 'https://zerion.io', description: 'DeFi portfolio manager', description_zh: 'DeFi投资组合管理', pricing: 'free' },
  { name: 'Zapper', name_zh: 'Zapper', website: 'https://zapper.xyz', description: 'Multi-chain DeFi dashboard', description_zh: '多链DeFi仪表板', pricing: 'free' },
  { name: 'DeBank', name_zh: 'DeBank', website: 'https://debank.com', description: 'Web3 portfolio tracker', description_zh: 'Web3资产追踪', pricing: 'free' },
  { name: 'Bubblемaps', name_zh: 'Bubblemaps', website: 'https://bubblemaps.io', description: 'Token holder visualization', description_zh: '代币持仓可视化', pricing: 'freemium' },
  { name: 'Parsec', name_zh: 'Parsec', website: 'https://parsec.finance', description: 'DeFi analytics dashboard', description_zh: 'DeFi分析仪表板', pricing: 'freemium' },
  { name: 'Artemis', name_zh: 'Artemis', website: 'https://www.artemis.xyz', description: 'Cross-chain analytics', description_zh: '跨链分析平台', pricing: 'freemium' },
  { name: 'IntoTheBlock', name_zh: 'IntoTheBlock', website: 'https://www.intotheblock.com', description: 'Crypto analytics & signals', description_zh: '加密分析与信号', pricing: 'freemium' },
  { name: 'LunarCrush', name_zh: 'LunarCrush', website: 'https://lunarcrush.com', description: 'Social analytics for crypto', description_zh: '加密社交分析', pricing: 'freemium' },
  { name: 'Footprint Analytics', name_zh: 'Footprint', website: 'https://www.footprint.network', description: 'Blockchain data analytics', description_zh: '区块链数据分析', pricing: 'freemium' },
  { name: 'RootData', name_zh: 'RootData', website: 'https://www.rootdata.com', description: 'Web3 asset data platform', description_zh: 'Web3资产数据平台', pricing: 'free' },
]

const QUANT_PLATFORMS = [
  { name: '3Commas', name_zh: '3Commas', website: 'https://3commas.io', description: 'Automated trading bots', description_zh: '自动交易机器人', pricing: 'paid' },
  { name: 'Cryptohopper', name_zh: 'Cryptohopper', website: 'https://www.cryptohopper.com', description: 'AI-powered trading bot', description_zh: 'AI交易机器人', pricing: 'paid' },
  { name: 'Hummingbot', name_zh: 'Hummingbot', website: 'https://hummingbot.org', description: 'Open source market making bot', description_zh: '开源做市机器人', pricing: 'open_source', github_url: 'https://github.com/hummingbot/hummingbot' },
  { name: 'Freqtrade', name_zh: 'Freqtrade', website: 'https://www.freqtrade.io', description: 'Open source crypto trading bot', description_zh: '开源加密交易机器人', pricing: 'open_source', github_url: 'https://github.com/freqtrade/freqtrade' },
  { name: 'Jesse', name_zh: 'Jesse', website: 'https://jesse.trade', description: 'Python framework for algo trading', description_zh: 'Python算法交易框架', pricing: 'open_source', github_url: 'https://github.com/jesse-ai/jesse' },
  { name: 'Zenbot', name_zh: 'Zenbot', website: 'https://github.com/DeviaVir/zenbot', description: 'Lightweight trading bot', description_zh: '轻量级交易机器人', pricing: 'open_source', github_url: 'https://github.com/DeviaVir/zenbot' },
  { name: 'CCXT', name_zh: 'CCXT', website: 'https://ccxt.com', description: 'Unified crypto exchange library', description_zh: '统一加密交易所库', pricing: 'open_source', github_url: 'https://github.com/ccxt/ccxt' },
  { name: 'Backtrader', name_zh: 'Backtrader', website: 'https://www.backtrader.com', description: 'Python backtesting library', description_zh: 'Python回测库', pricing: 'open_source', github_url: 'https://github.com/mementum/backtrader' },
  { name: 'Vectorbt', name_zh: 'Vectorbt', website: 'https://vectorbt.dev', description: 'Vectorized backtesting in Python', description_zh: 'Python向量化回测', pricing: 'open_source', github_url: 'https://github.com/polakowo/vectorbt' },
  { name: 'QuantConnect', name_zh: 'QuantConnect', website: 'https://www.quantconnect.com', description: 'Algorithmic trading platform', description_zh: '算法交易平台', pricing: 'freemium' },
  { name: 'TradingBot', name_zh: 'TradingBot', website: 'https://tradingbot.com', description: 'No-code trading bot builder', description_zh: '无代码交易机器人', pricing: 'paid' },
  { name: 'Shrimpy', name_zh: 'Shrimpy', website: 'https://www.shrimpy.io', description: 'Portfolio management & rebalancing', description_zh: '投资组合管理与再平衡', pricing: 'freemium' },
  { name: 'Pionex', name_zh: 'Pionex', website: 'https://www.pionex.com', description: 'Exchange with built-in trading bots', description_zh: '内置交易机器人的交易所', pricing: 'free' },
  { name: 'Bitsgap', name_zh: 'Bitsgap', website: 'https://bitsgap.com', description: 'Trading bot & portfolio tracker', description_zh: '交易机器人与投资组合追踪', pricing: 'paid' },
  { name: 'Cornix', name_zh: 'Cornix', website: 'https://www.cornix.io', description: 'Automated crypto trading', description_zh: '自动加密交易', pricing: 'paid' },
  { name: 'Tradesanta', name_zh: 'TradeSanta', website: 'https://tradesanta.com', description: 'Cloud-based trading bot', description_zh: '云端交易机器人', pricing: 'freemium' },
  { name: 'Mudrex', name_zh: 'Mudrex', website: 'https://mudrex.com', description: 'Algo trading made easy', description_zh: '简化的算法交易', pricing: 'paid' },
  { name: 'Quadency', name_zh: 'Quadency', website: 'https://quadency.com', description: 'Professional crypto trading platform', description_zh: '专业加密交易平台', pricing: 'freemium' },
  { name: 'WunderTrading', name_zh: 'WunderTrading', website: 'https://wundertrading.com', description: 'Social & automated trading', description_zh: '社交与自动交易', pricing: 'freemium' },
  { name: 'OctoBot', name_zh: 'OctoBot', website: 'https://www.octobot.cloud', description: 'Open source trading bot', description_zh: '开源交易机器人', pricing: 'open_source', github_url: 'https://github.com/Drakkar-Software/OctoBot' },
]

async function seed() {
  console.log('Seeding trading tools...')
  const toolRows = TRADING_TOOLS.map(t => ({ ...t, category: 'trading_tool' }))
  const { error: e1 } = await supabase.from('tools').insert(toolRows).select()
  if (e1) console.error('Trading tools error:', e1.message)
  else console.log(`  ${toolRows.length} trading tools inserted`)

  console.log('Seeding quant platforms...')
  const quantRows = QUANT_PLATFORMS.map(t => ({ ...t, category: 'quant_platform' }))
  const { error: e2 } = await supabase.from('tools').insert(quantRows).select()
  if (e2) console.error('Quant platforms error:', e2.message)
  else console.log(`  ${quantRows.length} quant platforms inserted`)

  console.log('Done!')
}

seed().catch(console.error)
