/**
 * Arena Data Pipeline - Scraper Registry
 *
 * 所有平台采集器的统一入口
 * 导入此文件会自动注册所有 scraper
 */

// CEX Futures
export * from './binance-futures'
export * from './okx-futures'
export * from './bybit-futures'
export * from './bitget-futures'
export * from './mexc-futures'
export * from './htx-futures'
export * from './coinex-futures'
export * from './gateio-futures'
export * from './kucoin-futures'
export * from './phemex-futures'
export * from './bingx-futures'
export * from './bitunix-futures'
export * from './blofin-futures'

// DEX / Perp
export * from './hyperliquid'
export * from './gmx'
export * from './dydx'
export * from './drift'
export * from './aevo'
export * from './jupiter-perps'
export * from './gains'
export * from './kwenta'

// Social Trading
export * from './etoro'
