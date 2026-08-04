# Add Ingest Source Adapter

The legacy connector runtime is retired. Treat this command as an adapter
onboarding workflow; never recreate `connectors/`, `lib/connectors/`, or a
Vercel leaderboard-fetch loop.

1. Read `docs/ADAPTER_ONBOARDING.md` and `docs/REPOSITORY_STRUCTURE.md`.
2. Research the upstream surface, fields, geo restrictions, pagination, and rate limits.
3. Add `lib/ingest/adapters/<source>/` with network acquisition separated from pure parsers.
4. Capture real RAW fixtures and add parser plus expected-metric parity tests.
5. Register the adapter in `lib/ingest/adapters/register.ts`.
6. Create a forward migration for the `arena.sources` registry row with
   `scripts/new-migration.sh`; do not edit migration history.
7. Verify the worker path and serving contract:

```bash
npm run qa:architecture
npm run qa:schema
npm run type-check
npm test -- --runInBand lib/ingest/adapters
npm run build
```

Activation is an operational decision. Adapter code, registry status, serving
mode, source freshness, and visible-source policy must all agree before launch.
