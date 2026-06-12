/**
 * Adapter registration — imported once by the ingest worker bootstrap.
 * Each adapter module registers itself via registerAdapter() on import.
 * Adding a source = one adapter module + one arena.sources seed row.
 */

// Phase 0
import './bitget'
import './bitget/bots'

// Phase 1
import './binance'
import './bybit-mt5'
import './bybit-copytrade'
import './mexc'
import './hyperliquid'

// Phase 2 — long-tail batch 1 (simple CEX futures family)
import './coinex'
import './htx'
import './kucoin'
import './phemex'
import './lbank'

// Phase 2 — long-tail batch 2 (paired futures/spot CEX family)
import './gate'
import './xt'
import './blofin'
import './bingx'

export {}
