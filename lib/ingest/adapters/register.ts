/**
 * Adapter registration — imported once by the ingest worker bootstrap.
 * Each adapter module registers itself via registerAdapter() on import.
 * Adding a source = one adapter module + one arena.sources seed row.
 */

// Phase 0
import './bitget'
import './bitget/bots'

// Phase 1
import './bybit-mt5'
import './mexc'

export {}
