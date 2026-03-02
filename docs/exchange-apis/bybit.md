# Bybit (Futures) API

**Status**: 🔄 In Progress  
**Priority**: P1  
**Data Gap**: 43.6%  
**Last Updated**: 2026-03-02

---

## Discovery Status

⚠️ **Auto-discovery incomplete** - Need manual API research

## Expected API Pattern

Based on Bybit's API structure (similar to existing Bybit integrations):

### Trader Ranking
```
GET https://api.bybit.com/v5/copy-trading/trader/ranking
```

### Trader Detail
```
GET https://api.bybit.com/v5/copy-trading/trader/detail?traderId=<id>
```

### Parameters (likely)

| Param | Type | Description |
|-------|------|-------------|
| `traderId` | string | Trader unique ID |
| `timeWindow` | string | 7D, 30D, 90D |
| `sortBy` | string | roi, pnl, followers |

## Next Steps

1. Visit https://www.bybit.com/copy-trading
2. Open DevTools Network tab
3. Identify ranking and detail endpoints
4. Document request/response format
5. Map fields to DB schema

## Related Files

- Import script: `scripts/import/import_bybit_futures.mjs` (check if exists)
- Enrichment: TBD

---

*This file will be updated once API endpoints are confirmed.*
