# Add New Exchange Connector

Guide for adding a new exchange connector to Arena.

## 1. Research Phase

- [ ] Find exchange's copy-trading/leaderboard API
- [ ] Document API endpoints and authentication
- [ ] Check if geo-blocked (test from VPS if needed)
- [ ] Identify data fields available (ROI, PnL, followers, etc.)

## 2. Create Connector File

Create `lib/connectors/{exchange}.ts`:

```typescript
import { BaseConnector, ConnectorCapabilities } from './base';
import { TraderSnapshot, TraderDetails } from './types';

export class ExchangeConnector extends BaseConnector {
  readonly source = 'exchange_name';

  readonly capabilities: ConnectorCapabilities = {
    hasLeaderboard: true,
    hasEnrichment: true,
    periods: ['7D', '30D', '90D'],
  };

  async fetchLeaderboard(period: string): Promise<TraderSnapshot[]> {
    // Implement API call
    // Use this.rateLimiter.execute() for rate limiting
    // Use this.circuitBreaker.execute() for fault tolerance
  }

  async fetchTraderDetails(traderId: string): Promise<TraderDetails | null> {
    // Implement enrichment API call
  }
}
```

## 3. Register Connector

Add to `lib/connectors/index.ts`:

```typescript
import { ExchangeConnector } from './exchange';

export const connectors = {
  // ... existing
  exchange_name: new ExchangeConnector(),
};
```

## 4. Add to Batch Group

Update `vercel.json` or `lib/cron/batch-groups.ts`:

```typescript
export const batchGroups = {
  a: ['binance_futures', ...],
  b: ['bybit', 'exchange_name', ...],  // Add to appropriate group
  // ...
};
```

## 5. Create Migration (if new fields needed)

```sql
-- supabase/migrations/00XXX_add_exchange_support.sql
-- Usually not needed if using existing schema
```

## 6. Test

```bash
# Test connector directly
npx tsx -e "
const { connectors } = require('./lib/connectors');
const c = connectors.exchange_name;
c.fetchLeaderboard('7D').then(console.log);
"

# Test via API
curl http://localhost:3000/api/cron/fetch-traders/exchange_name?periods=7D
```

## 7. Monitor

- Check first few cron runs
- Verify data in Supabase dashboard
- Watch for rate limit errors in logs

## Connector Checklist
- [ ] Implements `fetchLeaderboard`
- [ ] Implements `fetchTraderDetails` (if available)
- [ ] Uses rate limiter
- [ ] Handles errors gracefully
- [ ] Maps to standard `TraderSnapshot` schema
- [ ] Added to batch group
- [ ] Tested locally
- [ ] Documented in PROGRESS.md
