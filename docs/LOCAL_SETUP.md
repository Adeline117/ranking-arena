# Local Development Setup (for collaborators)

Get Arena running locally in ~10 minutes. You need: **Node 20+**, git, and
collaborator access to this repo.

## Quick start

```bash
git clone git@github.com:Adeline117/ranking-arena.git
cd ranking-arena
npm install                        # repo ships .npmrc (legacy-peer-deps) — plain npm install works
bash scripts/setup-local-env.sh    # writes .env.local (public client values only)
npm run dev                        # → http://localhost:3000
```

That's it. Rankings, trader detail pages, login, and community features all
work against the live database (RLS enforces permissions).

## What to expect

- **First visit to each page is slow** — dev mode compiles pages on demand
  (Turbopack). The second visit is fast. This is normal, not a bug.
- The dev server wants ~3.5 GB of heap (already configured in the npm script).
  On an 8 GB machine, close heavy apps first.
- Server-side features (payments/Stripe, cron jobs, Redis cache, ingest
  worker) are **intentionally unconfigured** locally and degrade gracefully.
  Frontend testing is unaffected.

## About the credentials

`scripts/setup-local-env.sh` writes only the `NEXT_PUBLIC_*` Supabase URL and
publishable (anon) key. These are **public by design** — they ship inside the
site's JS bundle to every visitor; security is enforced by Postgres RLS.

You do **not** need (and should not ask for) `SUPABASE_SERVICE_ROLE_KEY`,
`CRON_SECRET`, Stripe keys, or DB connection strings for local frontend work.
If a task genuinely needs server secrets, ask the owner — they are shared via
1Password, never chat.

## Troubleshooting

| Symptom                                     | Cause                                                                 | Fix                                                                    |
| ------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Every page slow, Supabase errors in console | `.env.local` typo'd/corrupted (often by chat apps mangling long keys) | `rm .env.local && bash scripts/setup-local-env.sh`, restart dev server |
| `Invalid API key` / 401 in console          | same as above                                                         | same as above                                                          |
| Weird build/runtime errors                  | Node < 20, or deps installed with yarn/pnpm                           | `node -v` (need ≥20); `rm -rf node_modules && npm install`             |
| Only the first page-load is slow            | dev on-demand compile                                                 | normal — revisit the page                                              |
| Changed `.env.local` but nothing happened   | env is read at boot                                                   | restart `npm run dev`                                                  |
