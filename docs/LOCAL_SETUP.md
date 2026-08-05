# Local Development Setup (for collaborators)

Get Arena running locally in ~10 minutes. You need: **Node 22**, git, and
collaborator access to this repo.

## Quick start

```bash
git clone git@github.com:Adeline117/ranking-arena.git
cd ranking-arena
npm ci                             # installs the lockfile and repository-managed Git hook
bash scripts/setup-local-env.sh    # writes .env.local (public client values only)
npm run dev                        # → http://localhost:3000
```

The repository pins its runtime in `.nvmrc`; run `nvm use` before installing
dependencies when your shell does not already use Node 22. The `prepare`
step installs the version-controlled pre-commit hook in clones and worktrees.

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

| Symptom                                     | Cause                                                                 | Fix                                                                              |
| ------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Every page slow, Supabase errors in console | `.env.local` typo'd/corrupted (often by chat apps mangling long keys) | `rm .env.local && bash scripts/setup-local-env.sh`, restart dev server           |
| `Invalid API key` / 401 in console          | same as above                                                         | same as above                                                                    |
| Weird build/runtime errors                  | Wrong Node major, or deps installed with yarn/pnpm                    | `nvm use`; reinstall with `npm ci`                                               |
| Production build fails with `ENOSPC`        | Next's reusable webpack cache exceeds available local disk            | Delete generated `.next`, then run `ARENA_DISABLE_WEBPACK_CACHE=1 npm run build` |
| Only the first page-load is slow            | dev on-demand compile                                                 | normal — revisit the page                                                        |
| Changed `.env.local` but nothing happened   | env is read at boot                                                   | restart `npm run dev`                                                            |
