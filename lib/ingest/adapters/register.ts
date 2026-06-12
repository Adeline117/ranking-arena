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

// Phase 2 — long-tail batch 3 (wave 2)
import './btcc'
import './bitunix'
import './bitmart'

// Phase 2 — wave 2 on-chain (pure HTTP / JSON APIs)
import './gmx'
import './gtrade'
import './binance-web3'
import './okx-web3'

// Phase 3 — API-first / VPS-unblocked sources
import './bitfinex'

export {}
