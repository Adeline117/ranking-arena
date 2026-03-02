# Gate.io API

**Status**: 🔄 In Progress  
**Priority**: P1  
**Data Gap**: 43.0%  
**Last Updated**: 2026-03-02

---

## Discovery Status

⚠️ **Auto-discovery incomplete** - Need manual API research

## Known Information

Gate.io has existing enrichment scripts that may provide clues:
- Check `scripts/enrich-gateio-*.mjs` for working API patterns

## Expected API Pattern

### Trader Ranking
```
GET https://www.gate.io/futures_copy_trading/api/v1/futures/ranking
```

### Trader Detail (possible)
```
GET https://www.gate.io/futures_copy_trading/api/v1/futures/trader/detail?uid=<id>
```

## Next Steps

1. Review existing enrichment scripts for Gate.io
2. Visit https://www.gate.io/copy_trade
3. Open DevTools Network tab
4. Identify working endpoints
5. Document request/response format

## Related Files

- Import script: `scripts/import/import_gateio_futures.mjs` (check if exists)
- Enrichment: `scripts/enrich-gateio-*.mjs`

---

*This file will be updated once API endpoints are confirmed.*
