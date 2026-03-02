# Bybit Spot API

**Status**: 🔄 In Progress  
**Priority**: P1  
**Data Gap**: 43.9%  
**Last Updated**: 2026-03-02

---

## Discovery Status

⚠️ **Auto-discovery incomplete** - Need manual API research

## Expected API Pattern

Based on Bybit's general API structure, likely endpoints:

### Trader Ranking
```
GET https://api.bybit.com/spot/v3/public/trader/ranking
```

### Trader Detail
```
GET https://api.bybit.com/spot/v3/public/trader/detail?traderId=<id>
```

## Next Steps

1. Visit https://www.bybit.com/copy-trading/spot
2. Open DevTools Network tab
3. Identify ranking and detail endpoints
4. Document request/response format
5. Map fields to DB schema

## Related Files

- Import script: `scripts/import/import_bybit_spot.mjs` (if exists)
- Enrichment: TBD

---

*This file will be updated once API endpoints are confirmed.*
