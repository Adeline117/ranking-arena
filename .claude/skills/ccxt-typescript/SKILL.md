---
name: ccxt-typescript
description: CCXT usage patterns for Arena. Arena uses CCXT only for market data (tickers, OHLCV, trading pairs) — NOT for copy trading APIs (custom connectors handle those).
---

# CCXT in Arena

## How Arena Uses CCXT

Arena uses CCXT **only** for standardized market data:
- Ticker data (price, volume, 24h change)
- OHLCV candlestick data
- Trading pair lists
- Price lookups for PnL calculation

**NOT for**: Copy trading/leaderboard APIs — those use custom connectors in `lib/connectors/`.

Key file: `lib/exchange/ccxt-client.ts` — lazy-loads ccxt to avoid 56MB cold start impact.

## Supported Exchanges

```typescript
const SUPPORTED_EXCHANGES = [
  'binance', 'bybit', 'okx', 'bitget', 'mexc',
  'kucoin', 'gateio', 'htx', 'coinex', 'bingx',
  'phemex', 'xt', 'lbank',
]
```

## Common Patterns

### Fetch Ticker
```typescript
import ccxt from 'ccxt'
const exchange = new ccxt.binance()
await exchange.loadMarkets()
const ticker = await exchange.fetchTicker('BTC/USDT')
```

### Fetch OHLCV
```typescript
const candles = await exchange.fetchOHLCV('BTC/USDT', '1h', undefined, 100)
// Returns: [timestamp, open, high, low, close, volume][]
```

### Error Handling
```typescript
try {
  const ticker = await exchange.fetchTicker(symbol)
} catch (e) {
  if (e instanceof ccxt.NetworkError) {
    // Retry with backoff
  } else if (e instanceof ccxt.ExchangeError) {
    // Exchange-specific error (invalid symbol, etc.)
  } else if (e instanceof ccxt.RateLimitExceeded) {
    // Back off, reduce concurrency
  }
}
```

## Arena-Specific Notes

- Lazy-load via `await import('ccxt')` — never top-level import (56MB)
- Use `exchange.setSandboxMode(false)` — always production
- Some exchanges need `defaultType: 'swap'` for futures data
- Proxy: set `exchange.proxy = process.env.VPS_PROXY_URL` for geo-blocked exchanges
- Rate limits: CCXT has built-in rate limiting, but Arena adds `p-limit` for extra control
