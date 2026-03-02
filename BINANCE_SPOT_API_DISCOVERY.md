# Binance Spot API Discovery Report

**Date:** 2026-03-02  
**Status:** ✅ API Working  
**Location:** Singapore VPS (45.76.152.169)

## Key Findings

### 1. API Endpoint (Working)
```
POST https://www.binance.com/bapi/futures/v1/friendly/future/spot-copy-trade/common/home-page-list
```

### 2. Request Format
```json
{
  "pageNumber": 1,
  "pageSize": 100,
  "timeRange": "7D",  // Options: 7D, 30D, 90D
  "dataType": "ROI",
  "order": "DESC"
}
```

### 3. Required Headers
```
Content-Type: application/json
User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36
Accept-Encoding: gzip
```

### 4. Test Results

**Singapore VPS (45.76.152.169):**
```bash
curl -s -X POST 'https://www.binance.com/bapi/futures/v1/friendly/future/spot-copy-trade/common/home-page-list' \
  -H 'Content-Type: application/json' \
  -H 'User-Agent: Mozilla/5.0' \
  -H 'Accept-Encoding: gzip' \
  --compressed \
  -d '{"pageNumber":1,"pageSize":10,"timeRange":"7D","dataType":"ROI","order":"DESC"}'
```

Response: `{"code":"000000","message":null,"data":{...}}`  
✅ **Success - No geo-block**

**Japan VPS (149.28.27.242):**
- Old endpoint returned 404 (endpoint changed)
- New endpoint not tested yet

### 5. Data Available
From API response, each trader object contains:
- `leadPortfolioId` - Trader ID
- `chartItems` - ROI chart data (for win_rate calculation)
- `tradingDays` - Can be used as trades_count proxy
- `aum` - Assets under management
- `roi` - Return on investment
- `avatarUrl`, `nickName` - Profile info

### 6. Existing Script
Location: `/opt/arena/scripts/import/enrich_binance_spot_v2.mjs`
- Uses this API endpoint ✅
- Computes win_rate from chartItems (% of positive ROI days)
- Uses tradingDays as trades_count
- Ready to run on Singapore VPS

## Next Steps

1. ✅ Verify Singapore VPS has Supabase credentials
2. 🔄 Run enrichment script on Singapore VPS
3. ⏳ Verify data fills null values
4. 📊 Check reduction in null counts

## Script Execution

```bash
# On Singapore VPS
ssh root@45.76.152.169
cd /opt/arena
node scripts/import/enrich_binance_spot_v2.mjs
```

Expected to fill:
- ~2094 trades_count nulls
- win_rate computed from chart data
