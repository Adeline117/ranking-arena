/**
 * Adapter registration — imported once by the ingest worker bootstrap.
 * Each adapter module registers itself via registerAdapter() on import.
 * Adding a source = one adapter module + one arena.sources seed row.
 */

// Phase 0
// import './bitget'        — registered in the Bitget adapter commit
// import './bitget/bots'

export {}
