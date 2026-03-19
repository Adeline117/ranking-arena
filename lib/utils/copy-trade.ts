/**
 * Copy-trade URL generation — shared between CopyTradeButton and ExchangeLinksBar.
 *
 * CEX: copy-trade page for the trader
 * DEX: explorer / portfolio page for the trader
 */

/** Generate copy-trade URL for CEX platforms */
export function getCopyTradeUrl(source: string | undefined, traderId: string, traderHandle?: string): string | null {
  if (!source) return null

  const urlMap: Record<string, string> = {
    binance_futures: `https://www.binance.com/zh-CN/copy-trading/lead-details/${traderId}?type=um`,
    binance_spot: `https://www.binance.com/zh-CN/copy-trading/lead-details/${traderId}`,
    binance_web3: `https://www.binance.com/zh-CN/copy-trading/lead-details/${traderId}`,
    binance: `https://www.binance.com/zh-CN/copy-trading/lead-details/${traderId}`,
    bybit: `https://www.bybit.com/copyTrade/trade-center/detail?leaderMark=${traderId}`,
    bitget_futures: `https://www.bitget.com/zh-CN/copy-trading/trader?id=${traderId}`,
    bitget_spot: `https://www.bitget.com/zh-CN/copy-trading/trader?id=${traderId}`,
    bitget: `https://www.bitget.com/zh-CN/copy-trading/trader?id=${traderId}`,
    okx: `https://www.okx.com/copy-trading/trader/${traderId}`,
    htx: `https://futures.htx.com/en-us/copytrading/futures/detail/${traderId}`,
    htx_futures: `https://futures.htx.com/en-us/copytrading/futures/detail/${traderId}`,
    weex: `https://www.weex.com/zh-CN/copy-trading/trader/${traderId}`,
    etoro: `https://www.etoro.com/people/${traderHandle || traderId}/portfolio`,
    mexc: `https://futures.mexc.com/copy-trading/trader/${traderId}`,
    bingx: `https://bingx.com/en/CopyTrading/tradeDetail/${traderId}`,
    phemex: `https://phemex.com/copy-trading/trader/${traderId}`,
    blofin: `https://blofin.com/en/copy-trade/details/${traderId}`,
    coinex: `https://www.coinex.com/copy-trading/trader/${traderId}`,
    xt: `https://www.xt.com/en/copy-trading/trader/${traderId}`,
    btcc: `https://www.btcc.com/en-US/copy-trading`,
    toobit: `https://www.toobit.com/en-US/copy-trading`,
    bitunix: `https://www.bitunix.com/copy-trading`,
  }

  return urlMap[source.toLowerCase()] || null
}

/** Generate DEX explorer/profile URL */
export function getDexUrl(source: string | undefined, traderId: string): string | null {
  if (!source) return null

  const urlMap: Record<string, string> = {
    hyperliquid: `https://app.hyperliquid.xyz/explorer/address/${traderId}`,
    dydx: `https://trade.dydx.exchange/portfolio/${traderId}`,
    gmx: `https://app.gmx.io/#/actions/v2/${traderId}`,
    jupiter_perps: `https://www.jup.ag/perps/${traderId}`,
    drift: `https://app.drift.trade/overview?userAccount=${traderId}`,
    aevo: `https://app.aevo.xyz/portfolio/${traderId}`,
    gains: `https://gains.trade`,
    vertex: `https://app.vertexprotocol.com/portfolio/${traderId}`,
  }

  return urlMap[source.toLowerCase()] || null
}
