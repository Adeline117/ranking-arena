# Skill: Enrichment Script Development & Debug

Enrichment scripts live in `scripts/` and run as Node.js ESM (.mjs) or TypeScript (.ts via tsx).
They read from Supabase, call exchange APIs / puppeteer scrapers, and write back enriched data.

## Typical Workflow

1. **Identify scope** — which exchange, which data field (avatar, ROI, drawdown, positions)?
2. **Check existing scripts** — `ls scripts/ | grep <exchange>` before writing a new one.
3. **Scaffold**:
   ```js
   import { createClient } from '@supabase/supabase-js'
   import 'dotenv/config'
   const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
   ```
4. **Fetch targets** — query `traders` table, filter `WHERE field IS NULL LIMIT 100` for incremental runs.
5. **Rate-limit** — use `p-limit` (already in package.json). Default concurrency: 3.
6. **Upsert** — use `supabase.from('traders').upsert(rows, { onConflict: 'uid,exchange' })`.
7. **Dry-run first** — add `--dry-run` flag that logs without writing.

## Running Scripts
```bash
# mjs scripts
node --env-file=.env.local scripts/<script>.mjs

# ts scripts
npx tsx --env-file=.env.local scripts/<script>.ts

# with env vars manually
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/<script>.mjs
```

## Debug Checklist
- [ ] `SUPABASE_SERVICE_ROLE_KEY` loaded? Print `process.env.SUPABASE_URL` to confirm.
- [ ] Supabase RLS blocking writes? Use service role key (bypasses RLS).
- [ ] Exchange API returning 429? Reduce concurrency, add `await sleep(ms)`.
- [ ] Puppeteer failing headless? Add `--no-sandbox` arg; check `PUPPETEER_EXECUTABLE_PATH`.
- [ ] Data not persisting? Check upsert conflict keys match unique constraint in DB.

## Common Pitfalls
- Never use `INSERT` — always `UPSERT` to handle re-runs safely.
- `p-limit` concurrency >5 on Vercel free tier will hit Redis rate limit.
- Exchange avatar URLs expire — store URL + fetched_at timestamp.
- Never commit `.env.local` — only commit `.env.example` updates.

## File Naming Convention
`scripts/<action>-<exchange>-<field>.mjs`
Example: `backfill-binance-avatars.mjs`, `enrich-bybit-positions.mjs`
