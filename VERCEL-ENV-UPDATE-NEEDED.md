# Vercel Environment Variable Update Required

**Date**: 2026-03-15  
**Issue**: batch-fetch-traders failures due to missing VPS proxy configuration

## Required Action

Add the following environment variable to Vercel:

```
VPS_PROXY_SG=http://45.76.152.169:3456
```

## Steps

1. Go to Vercel Dashboard → ranking-arena project → Settings → Environment Variables
2. Add new variable:
   - Name: `VPS_PROXY_SG`
   - Value: `http://45.76.152.169:3456`
   - Environments: Production, Preview, Development (all)
3. Redeploy to apply changes

## Why This is Needed

- Connectors (Binance, Bybit, OKX, etc.) need to route through VPS proxy to avoid geo-blocking
- Currently `VPS_PROXY_SG` is not set in Vercel, causing `proxyUrl = undefined` in `registry.ts`
- This causes API requests from Vercel to be blocked by exchanges
- VPS proxy (arena-proxy) is running at 45.76.152.169:3456

## Related Files

- `lib/connectors/registry.ts` - reads `VPS_PROXY_SG` environment variable  
- `lib/connectors/base.ts` - uses `config.proxyUrl` for requests
- `.env.local` - updated locally (but not in git due to .gitignore)
- `.env.example` - already has VPS_PROXY_SG documented

## Verification

After adding the variable and redeploying, check:
1. Next batch-fetch-traders cron run succeeds
2. Pipeline logs show successful API calls
3. No more "403 Forbidden" or "IP blocked" errors
