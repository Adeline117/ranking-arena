/**
 * Uniswap v3 链上数据connector
 * 数据源: The Graph API (免费tier)
 */

import { createPublicClient, http } from 'viem'
import { mainnet } from 'viem/chains'

const UNISWAP_V3_SUBGRAPH = 'https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3'

export async function fetchUniswapV3TopTraders(limit = 100) {
  const query = `
    query TopSwappers {
      swaps(
        first: ${limit}
        orderBy: amountUSD
        orderDirection: desc
        where: { timestamp_gte: ${Math.floor(Date.now() / 1000) - 86400 * 7} }
      ) {
        sender
        amountUSD
        timestamp
      }
    }
  `
  
  const response = await fetch(UNISWAP_V3_SUBGRAPH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query })
  })
  
  const data = await response.json()
  return data.data.swaps
}

export async function getTraderStats(address: string) {
  // TODO: 聚合该地址的交易统计
  return {
    total_volume: 0,
    trades_count: 0,
    win_rate: 0,
    pnl: 0
  }
}
