# Verified Position-History Staged Rollout

This runbook releases the reviewed `@2` position-history path for
`binance_futures`, `bitget_futures`, and `okx_futures`. It is an expand-first
change: existing 2C history stays readable until each trader identity has its
first verified publication. Follow [ADR-023](./DECISIONS.md#adr-023-production-migrations-require-a-proven-single-file-channel)
and the normal [application](./DEPLOYMENT.md) and
[ingest-worker](./INGEST_WORKER_DEPLOY.md) release controls.

## Release invariants

- Use one operator and one serialized production-schema session. Apply exactly
  one reviewed file per Supabase MCP `apply_migration` call; never use `db push`,
  `--include-all`, ledger repair, or an SQL-editor copy.
- Use the filename description, not its timestamp, as the MCP migration name:
  `verified_position_history_raw_prerequisites` and then
  `verified_position_history_publication_authority`. MCP assigns the ledger
  version, so the returned version is recorded evidence, not a value that must
  equal the local filename timestamp.
- Keep `origin/main` frozen from phase 0 through the final canary. The migration
  bytes, both worker regions, and the application promotion must all identify
  the same reviewed 40-character current-main SHA. Do not run either migration
  from an uncommitted worktree, and do not make an independent UI change during
  this rollout.
- Never infer success from an MCP success message, an HTTP 200, or a row count
  alone. Preserve the reviewed file SHA-256, exact migration-ledger row, live
  catalog/privilege proof, worker release identity, and 2C canary response.

## 0. Prove the release before production

Freeze merges to `main`, unrelated production deploys, and unrelated schema
writes; choose a quiet Tier-B window. Keep that freeze until phase 5 completes.
From a clean checkout, prove that the candidate is the exact current
`origin/main`, then record its SHA and the SHA-256 of both reviewed migration
files.

```bash
set -euo pipefail
git fetch --force --no-tags origin refs/heads/main:refs/remotes/origin/main
test -z "$(git status --porcelain=v1 --untracked-files=all)"
CANDIDATE_SHA="$(git rev-parse HEAD)"
test "$CANDIDATE_SHA" = "$(git rev-parse refs/remotes/origin/main)"
printf '%s\n' "$CANDIDATE_SHA"
shasum -a 256 \
  supabase/migrations/20260803195000_verified_position_history_raw_prerequisites.sql \
  supabase/migrations/20260803200000_verified_position_history_publication_authority.sql
npm run qa:verified-position-history-pg17
npm run type-check
npm run type-check:ingest-worker
```

Immediately before every later mutating phase, fetch `origin/main` again and
require it still equals `CANDIDATE_SHA`. If it advanced, stop the rollout; do not
substitute the newer commit or deploy a mixed release under the old review.

The PG17 proof must apply the prerequisite and authority migrations in order and
cover runtime attacks, concurrency, privileges, triggers, gradual legacy
serving, verified publication, and cursor invalidation. A shell syntax check or
the static migration test is useful, but neither substitutes for this proof.

For each migration, pass the complete reviewed file bytes to one MCP
`apply_migration` call. Immediately after the call, use a read-only SQL query to
prove its exact ledger body:

```sql
SELECT
  name,
  version,
  pg_catalog.array_length(statements, 1) AS statement_count,
  pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(statements[1], 'UTF8'),
      'sha256'
    ),
    'hex'
  ) AS statement_sha256
FROM supabase_migrations.schema_migrations
WHERE name = '<exact_migration_name>'
ORDER BY version;
```

Require exactly one row, `statement_count = 1`, and a hash equal to the local
file hash recorded above. If the MCP result is ambiguous, query the ledger and
live catalog before any retry. Never retry merely because the client timed out.

## 1. Apply the RAW prerequisite

Apply only
`20260803195000_verified_position_history_raw_prerequisites.sql` with migration
name `verified_position_history_raw_prerequisites`, then run the exact ledger
check above and `npm run qa:schema`. Treat the global `qa:migrations` result as
advisory, per ADR-023; it cannot replace the exact row/body proof.

The migration's catalog-exact postflight must succeed in the same transaction.
Independently confirm that `arena.position_history_raw_admissions` is owned by
`postgres`, has enabled and forced RLS, and grants no table access to `anon`,
`authenticated`, or `service_role`. Confirm every new RAW/source/trader guard is
present with `pg_trigger.tgenabled = 'A'` (`ENABLE ALWAYS`) and its expected
`tgfoid`. The original eleven-column `arena.raw_objects` shape must be unchanged.

This phase is additive and does not backfill or scan the large RAW table. An
eligible `@2` insert creates one immutable admission in the same transaction;
the currently serving worker emits no eligible `@2` artifact, and legacy RAW
remains outside this admission path. Before any reviewed worker deployment,
require the new ledger to be exactly empty:

```sql
SELECT pg_catalog.count(*) AS pre_worker_admission_rows
FROM arena.position_history_raw_admissions;
```

The only acceptable result is `pre_worker_admission_rows = 0`. Any row means an
unexpected writer already crossed the admission boundary or the runtime phases
are mixed. Stop, preserve the row, identify its exact `source_run_id` and worker
release, and resolve that incident before continuing. Do not treat it as the
rollout canary.

## 2. Apply the publication authority with the old runtime serving

Keep the previously proven application and both previously proven workers in
production. Apply only
`20260803200000_verified_position_history_publication_authority.sql` with name
`verified_position_history_publication_authority`. Repeat the exact ledger hash
check and `npm run qa:schema`. Require one exact ledger row for each of the two
migration names.

The migration's postflight must prove the immutable private tables, forced RLS,
ALWAYS mutation guards, source contracts, function owners/search paths, and
privileges. In particular:

- `arena.publish_verified_position_history(bigint,text,bigint,text)` exists,
  is owned by `postgres`, and is not executable by `PUBLIC`, `anon`,
  `authenticated`, or `service_role`;
- `public.arena_records_page(text,text,text,integer,text,integer)` is owned by
  `postgres` and executable by the three API roles;
- the source registry is exactly Binance/binance/USDT,
  Bitget/bitget/USDT, and OKX/okx/USDT with the reviewed parser/verifier
  versions; and
- there is no unvalidated constraint or partially installed authority object.

Do not replay either migration as a postflight check: both are intentionally
fail-closed when their objects already exist.

This is the expand-compatible window. The old workers never emit the reviewed
`@2` envelope, so they continue their legacy path without touching the new
authority. The replaced `arena_records_page` keeps legacy position history
readable until an identity has a verified publication. Before deploying either
worker, use a reviewed trader with known legacy rows and prove through an API
role that the internal RPC returns those rows with null publication identity and
`unknown/history_evidence_not_bound`. An old application may not expose all new
completeness fields, so its bounded 2C proof is HTTP 200 and no legacy row loss;
do not mislabel that response as verified complete.

Do not replay or manually invoke the owner-only publication function. Re-run the
zero-admission query from phase 1 immediately before the first worker deployment
and still require exactly zero.

## 3. Deploy both `@2` workers on the exact current-main release

Keep the old application in production. Deploy the Mac Mini `local` owner and
the Singapore `vps_sg` owner through their separate documented transactional
workflows. Both must identify `CANDIDATE_SHA`, derive the same reviewed
`WORKER_RELEASE_ID`, advertise attempt-bound capture, and complete fresh
marker/heartbeat identity proof. There must be exactly one healthy owner for
each required region, with no stale, duplicate, failover, or mixed-release
owner.

The first Tier-B attempt now persists the immutable RAW object and admission in
its independent first transaction, then invokes the installed owner-only
publication authority. Preserve the exact `source_run_id` and both transaction
outcomes if publication fails; do not delete, rewrite, or manually promote the
admitted evidence.

Do not deliberately trigger the rollout canary until both regions are healthy.
If a natural Tier-B run lands while the second region is still deploying,
preserve it, but do not use it as the final two-region canary. A failed
transactional deployment may automatically restore that region's complete
previous directory while it still holds its deployment lease; that is a failed
cutover, not permission for a later manual old-SHA rollback. After either region
has completed the new release, fix and redeploy `CANDIDATE_SHA`, or stop and
prepare a reviewed revert/forward commit that becomes the new current `main`.

## 4. Re-run the same-SHA Deploy Gate and promote the application

The first Deploy Gate run for `CANDIDATE_SHA` may have built an unaliased Vercel
candidate and withheld production promotion because the exact worker fleet was
not ready. That is expected. Once both worker regions pass their release proof,
re-run that same Deploy Gate run (all failed/skipped jobs as required) and prove
its `HEAD_SHA` is still exactly `CANDIDATE_SHA`. Do not create an empty commit,
advance `main`, use the deploy-force escape path, or manually promote a Vercel
deployment to manufacture another attempt.

The Gate must recompute the candidate's `WORKER_RELEASE_ID`, call the protected
worker-fleet readiness endpoint against the unaliased candidate, and observe one
fresh exact owner for both `local` and `vps_sg` before it writes the production
alias. Preserve the successful Gate run URL, Vercel deployment identity, public
`/api/health` response, exact application SHA, and smoke result. Only after this
step do the schema, workers, and 2C application all identify the same frozen
current-main release.

## 5. Prove the 2C cutover with one bounded source run

Use an exact reviewed trader/source canary and preserve the response and worker
receipt. Never select “the latest” admission/publication or correlate rows by
timestamp proximity. Set the exact receipt values first:

```bash
set -euo pipefail
export CANARY_DIR="$(mktemp -d /tmp/arena-vph-canary.XXXXXX)"
chmod 700 "$CANARY_DIR"
printf 'Canary evidence directory: %s\n' "$CANARY_DIR"
export SOURCE_RUN_ID='<64-lowercase-hex receipt sourceRunId>'
export RECEIPT_PUBLICATION_ID='<positive receipt publicationId>'
export RECEIPT_RAW_OBJECT_ID='<positive receipt rawObjectId>'
export RECEIPT_PUBLICATION_SHA256='<64-lowercase-hex receipt publicationSha256>'
export RECEIPT_FACTS_ADDED='<non-negative receipt factsAdded>'
export RECEIPT_FACTS_REUSED='<non-negative receipt factsReused>'
export SOURCE_SLUG='<exact receipt-bound source slug>'
export EXCHANGE_TRADER_ID='<exact receipt-bound exchange trader id>'
export TRADER_HANDLE='<public handle resolving to that same identity>'
test "${#SOURCE_RUN_ID}" -eq 64
test "${#RECEIPT_PUBLICATION_SHA256}" -eq 64
case "$SOURCE_SLUG" in
  binance_futures | bitget_futures | okx_futures) ;;
  *) exit 2 ;;
esac
```

Use the first successful receipt with `replayed = false`; a later idempotent
replay reports reused counts for reconciliation and is not the rollout canary.
Do not install an automatic cleanup trap: preserve `CANARY_DIR` on any failure.
After a successful three-source rollout, archive it under the approved audit
retention policy or remove it safely after that archive is verified.

Run this read-only, unique-key-bound database proof using the production
operator connection. It checks one admission/acquisition/publication graph,
the immutable acquisition copy (which remains valid after normal RAW GC), the
receipt, terminal contract, relational counts, payload digests, every
payload-represented persisted binding field, and the stored binding identity and
fact-ID cardinality:

```bash
psql "$DATABASE_URL" \
  -X -v ON_ERROR_STOP=1 \
  -v source_run_id="$SOURCE_RUN_ID" \
  -v receipt_publication_id="$RECEIPT_PUBLICATION_ID" \
  -v receipt_raw_object_id="$RECEIPT_RAW_OBJECT_ID" \
  -v receipt_publication_sha256="$RECEIPT_PUBLICATION_SHA256" \
  -v receipt_facts_added="$RECEIPT_FACTS_ADDED" \
  -v receipt_facts_reused="$RECEIPT_FACTS_REUSED" \
  -v source_slug="$SOURCE_SLUG" \
  -v exchange_trader_id="$EXCHANGE_TRADER_ID" <<'SQL'
BEGIN TRANSACTION READ ONLY;

WITH target AS (
  SELECT
    admission.*,
    acquisition.acquisition_id,
    acquisition.raw_object_id AS acquired_raw_object_id,
    acquisition.source_run_id AS acquired_source_run_id,
    acquisition.source_id AS acquired_source_id,
    acquisition.trader_id AS acquired_trader_id,
    acquisition.source_slug AS acquired_source_slug,
    acquisition.exchange_trader_id AS acquired_exchange_trader_id,
    acquisition.raw_storage_path,
    acquisition.raw_content_hash,
    acquisition.raw_bytes,
    acquisition.raw_fetched_at,
    acquisition.raw_meta,
    acquisition.page_count,
    acquisition.verifier_contract,
    acquisition.scan_terminal_state AS acquired_terminal_state,
    publication.publication_id,
    publication.previous_publication_id,
    publication.source_run_id AS published_source_run_id,
    publication.source_id AS published_source_id,
    publication.trader_id AS published_trader_id,
    publication.scan_terminal_state AS published_terminal_state,
    publication.parsed_row_count,
    publication.binding_count,
    publication.partial_row_count,
    publication.unique_fact_count,
    publication.new_fact_count,
    publication.binding_set_sha256,
    publication.publication_sha256,
    publication.publication_payload,
    contract.terminal_verifier_contract
  FROM arena.position_history_raw_admissions AS admission
  JOIN arena.position_history_acquisitions AS acquisition
    ON acquisition.raw_object_id = admission.raw_object_id
   AND acquisition.source_run_id = admission.source_run_id
   AND acquisition.source_id = admission.source_id
   AND acquisition.trader_id = admission.trader_id
  JOIN arena.position_history_publications AS publication
    ON publication.acquisition_id = acquisition.acquisition_id
   AND publication.source_run_id = acquisition.source_run_id
   AND publication.source_id = acquisition.source_id
   AND publication.trader_id = acquisition.trader_id
  JOIN arena.position_history_source_contracts AS contract
    ON contract.source_id = acquisition.source_id
   AND contract.source_slug = acquisition.source_slug
   AND contract.terminal_verifier_contract = acquisition.verifier_contract
  WHERE admission.source_run_id = :'source_run_id'
), payload_bindings AS (
  SELECT
    target.publication_id,
    binding.ordinality::integer AS payload_ordinal,
    binding.value
  FROM target
  CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
    ((target.publication_payload::jsonb)->>'bindings_canonical_json')::jsonb
  ) WITH ORDINALITY AS binding(value, ordinality)
), stored_bindings AS (
  SELECT
    binding.*,
    target.source_run_id AS expected_source_run_id,
    target.source_id AS expected_source_id,
    target.trader_id AS expected_trader_id
  FROM target
  JOIN arena.position_history_publication_bindings AS binding
    ON binding.publication_id = target.publication_id
), binding_proof AS (
  SELECT
    pg_catalog.count(*) AS compared_rows,
    pg_catalog.count(*) FILTER (
      WHERE stored.classification = 'canonical_materialized'
    ) AS materialized_rows,
    pg_catalog.count(*) FILTER (
      WHERE stored.classification = 'source_partial_omitted'
    ) AS partial_rows,
    pg_catalog.count(stored.fact_id) AS fact_id_rows,
    pg_catalog.count(DISTINCT stored.fact_id) AS distinct_fact_rows,
    pg_catalog.count(*) FILTER (
      WHERE stored.binding_ordinal IS NOT NULL
        AND (
          stored.source_run_id IS DISTINCT FROM
            stored.expected_source_run_id
          OR stored.source_id IS DISTINCT FROM stored.expected_source_id
          OR stored.trader_id IS DISTINCT FROM stored.expected_trader_id
        )
    ) AS identity_mismatch_rows,
    pg_catalog.count(*) FILTER (
      WHERE stored.binding_ordinal IS NOT NULL
        AND (
          (
            stored.classification = 'canonical_materialized'
            AND stored.fact_id IS NULL
          )
          OR (
            stored.classification = 'source_partial_omitted'
            AND stored.fact_id IS NOT NULL
          )
        )
    ) AS fact_shape_mismatch_rows,
    pg_catalog.count(*) FILTER (
      WHERE payload.payload_ordinal IS NULL
         OR stored.binding_ordinal IS NULL
         OR (payload.value->>'binding_ordinal')::integer
              IS DISTINCT FROM stored.binding_ordinal
         OR payload.value->>'classification'
              IS DISTINCT FROM stored.classification
         OR (payload.value->>'fact_ordinal')::integer
              IS DISTINCT FROM stored.fact_ordinal
         OR (payload.value->>'page_ordinal')::integer
              IS DISTINCT FROM stored.page_ordinal
         OR (payload.value->>'page_stored_index')::integer
              IS DISTINCT FROM stored.page_stored_index
         OR (payload.value->>'source_row_ordinal')::integer
              IS DISTINCT FROM stored.source_row_ordinal
         OR payload.value->>'page_payload_sha256'
              IS DISTINCT FROM stored.page_payload_sha256
         OR payload.value->>'page_fetched_at'
              IS DISTINCT FROM
                arena.position_history_timestamp_text(stored.page_fetched_at)
         OR payload.value->>'raw_row_sha256'
              IS DISTINCT FROM stored.raw_row_sha256
         OR payload.value->>'raw_row_canonical_json'
              IS DISTINCT FROM stored.raw_row_canonical_json
         OR payload.value->>'fact_sha256'
              IS DISTINCT FROM stored.fact_sha256
         OR payload.value->>'fact_canonical_json'
              IS DISTINCT FROM stored.fact_canonical_json
    ) AS mismatch_rows
  FROM payload_bindings AS payload
  FULL JOIN stored_bindings AS stored
    ON stored.binding_ordinal = payload.payload_ordinal
), graph_proof AS (
  SELECT
    pg_catalog.count(*) AS graph_rows,
    pg_catalog.coalesce(pg_catalog.bool_and(
      target.raw_object_id = :'receipt_raw_object_id'::bigint
      AND target.publication_id = :'receipt_publication_id'::bigint
      AND target.publication_sha256 = :'receipt_publication_sha256'
      AND target.new_fact_count = :'receipt_facts_added'::integer
      AND target.parsed_row_count - target.new_fact_count =
        :'receipt_facts_reused'::integer
      AND target.acquired_raw_object_id = target.raw_object_id
      AND target.acquired_source_run_id = target.source_run_id
      AND target.published_source_run_id = target.source_run_id
      AND target.acquired_source_id = target.source_id
      AND target.published_source_id = target.source_id
      AND target.acquired_trader_id = target.trader_id
      AND target.published_trader_id = target.trader_id
      AND target.acquired_source_slug = target.source_slug
      AND target.acquired_exchange_trader_id = target.exchange_trader_id
      AND target.source_slug = :'source_slug'
      AND target.exchange_trader_id = :'exchange_trader_id'
      AND target.raw_storage_path = target.storage_path
      AND target.raw_content_hash = target.content_hash
      AND target.raw_bytes = target.bytes
      AND target.raw_fetched_at = target.fetched_at
      AND target.raw_meta_sha256 =
        arena.position_history_raw_meta_sha256(target.raw_meta)
      AND target.raw_snapshot_sha256 =
        arena.position_history_raw_snapshot_sha256(
          target.raw_object_id,
          target.source_id,
          target.job_type,
          target.trader_id,
          target.timeframe,
          target.fetched_at,
          target.storage_path,
          target.bytes,
          target.content_hash,
          target.raw_meta_sha256
        )
      AND target.verifier_contract = target.terminal_verifier_contract
      AND target.acquired_terminal_state = target.published_terminal_state
      AND target.acquired_terminal_state IN ('exhausted', 'cursor_overlap')
      AND target.raw_meta->'termination'->>'scan_terminal_state' =
        target.acquired_terminal_state
      AND target.page_count =
        (target.raw_meta->>'page_count')::integer
      AND target.binding_count =
        target.parsed_row_count + target.partial_row_count
      AND target.unique_fact_count = target.parsed_row_count
      AND target.binding_set_sha256 = arena.position_history_text_sha256(
        (target.publication_payload::jsonb)->>'bindings_canonical_json'
      )
      AND target.publication_sha256 =
        arena.position_history_text_sha256(target.publication_payload)
      AND binding_proof.compared_rows = target.binding_count
      AND binding_proof.materialized_rows = target.parsed_row_count
      AND binding_proof.partial_rows = target.partial_row_count
      AND binding_proof.fact_id_rows = target.parsed_row_count
      AND binding_proof.distinct_fact_rows = target.unique_fact_count
      AND binding_proof.identity_mismatch_rows = 0
      AND binding_proof.fact_shape_mismatch_rows = 0
      AND binding_proof.mismatch_rows = 0
    ), false) AS exact_graph
  FROM target
  CROSS JOIN binding_proof
)
SELECT graph_rows = 1 AND exact_graph AS canary_pass
FROM graph_proof
\gset canary_

\if :canary_canary_pass
  \echo 'verified position-history graph: PASS'
\else
  \echo 'verified position-history graph: FAIL'
  \quit 3
\endif

ROLLBACK;
SQL
```

The command must exit zero and print exactly one graph `PASS`. The comparison is
bounded by the unique `source_run_id`, one publication, and at most the reviewed
100,000-binding contract; it does not scan global RAW or fact history.

Next prove the internal serving envelope through the real production PostgREST
anonymous path. Load the project URL and its anon/publishable key into the
environment from the approved store without placing the key in shell history.
Keep shell tracing disabled; the commands write responses to bounded local files
and never print the key. `p_trader` is the exchange identity, never the display
handle. Deliberately omit an `Authorization` header so this is an `anon` RPC,
not a user or service-role probe:

```bash
set +x
: "${SUPABASE_URL:?set the exact production Supabase URL}"
: "${SUPABASE_ANON_KEY:?load the production anon/publishable key}"
SUPABASE_URL="${SUPABASE_URL%/}"

RPC_BODY="$(jq -cn \
  --arg source "$SOURCE_SLUG" \
  --arg trader "$EXCHANGE_TRADER_ID" \
  '{
    p_source: $source,
    p_trader: $trader,
    p_kind: "position_history",
    p_tf: null,
    p_cursor: null,
    p_limit: 50
  }')"

curl --silent --show-error --fail-with-body \
  --connect-timeout 5 --max-time 20 --max-redirs 0 \
  --request POST \
  "$SUPABASE_URL/rest/v1/rpc/arena_records_page" \
  --header "apikey: $SUPABASE_ANON_KEY" \
  --header 'Content-Type: application/json' \
  --data "$RPC_BODY" \
  --output "$CANARY_DIR/rpc-page.json"

jq -e \
  --argjson publication_id "$RECEIPT_PUBLICATION_ID" \
  --arg source_run_id "$SOURCE_RUN_ID" '
    type == "object"
    and .publicationId == $publication_id
    and .stateId == $publication_id
    and .sourceRunId == $source_run_id
    and .completeness.publicationId == $publication_id
    and .completeness.contract == "arena.position-history-completeness@2"
    and .completeness.state == "complete"
    and .completeness.reason == "verified_terminal_history"
    and .completeness.evidenceState == "verified"
    and (
      .completeness.scanTerminalState == "exhausted"
      or .completeness.scanTerminalState == "cursor_overlap"
    )
    and .completeness.blockerReasons == []
    and (.rows | type == "array")
    and (
      .nextCursor == null
      or (.nextCursor | type == "string" and length > 0 and length <= 200)
    )
  ' "$CANARY_DIR/rpc-page.json"

NEXT_CURSOR="$(jq -r '.nextCursor // empty' \
  "$CANARY_DIR/rpc-page.json")"
if [[ -n "$NEXT_CURSOR" ]]; then
  NEXT_RPC_BODY="$(jq -cn \
    --arg source "$SOURCE_SLUG" \
    --arg trader "$EXCHANGE_TRADER_ID" \
    --arg cursor "$NEXT_CURSOR" \
    '{
      p_source: $source,
      p_trader: $trader,
      p_kind: "position_history",
      p_tf: null,
      p_cursor: $cursor,
      p_limit: 50
    }')"
  curl --silent --show-error --fail-with-body \
    --connect-timeout 5 --max-time 20 --max-redirs 0 \
    --request POST \
    "$SUPABASE_URL/rest/v1/rpc/arena_records_page" \
    --header "apikey: $SUPABASE_ANON_KEY" \
    --header 'Content-Type: application/json' \
    --data "$NEXT_RPC_BODY" \
    --output "$CANARY_DIR/rpc-next-page.json"
  jq -e \
    --argjson publication_id "$RECEIPT_PUBLICATION_ID" \
    --arg source_run_id "$SOURCE_RUN_ID" '
      .publicationId == $publication_id
      and .stateId == $publication_id
      and .sourceRunId == $source_run_id
      and .completeness.publicationId == $publication_id
      and .completeness.state == "complete"
      and .completeness.reason == "verified_terminal_history"
    ' "$CANARY_DIR/rpc-next-page.json"
fi
```

Require both `publicationId` and nested `completeness.publicationId` to equal
`stateId = RECEIPT_PUBLICATION_ID`, `sourceRunId = SOURCE_RUN_ID`, the exact
completeness contract `arena.position-history-completeness@2`,
`complete/verified_terminal_history/verified`, no blocker reasons, and terminal
state `exhausted` or `cursor_overlap`. Preserve `nextCursor`; when present, the
command requires the same immutable publication and source-run anchors.

Finally exercise the actual 2C route after the Gate promotion:

```bash
export ARENA_ORIGIN='https://www.arenafi.org'
ENCODED_TRADER_HANDLE="$(jq -rn --arg value "$TRADER_HANDLE" '$value | @uri')"

curl --silent --show-error --fail-with-body --get \
  "$ARENA_ORIGIN/api/traders/$ENCODED_TRADER_HANDLE/records" \
  --data-urlencode 'kind=position_history' \
  --data-urlencode "source=$SOURCE_SLUG" \
  --data-urlencode 'tf=90' \
  | tee "$CANARY_DIR/public-page.json" \
  | jq -e '
      .success == true
      and .data.completeness.state == "complete"
      and .data.completeness.reason == "verified_terminal_history"
      and .data.completeness.evidenceState == "verified"
      and (
        .data.completeness.scanTerminalState == "exhausted"
        or .data.completeness.scanTerminalState == "cursor_overlap"
      )
      and (.data.rows | type == "array")
    '
```

The public route intentionally strips internal publication and source-run IDs;
the preceding API-role proof is what binds this response to the immutable
publication. A verified empty array is acceptable only when that database proof
passed. If a pre-cutover legacy cursor was preserved, require an exact 409 reset:

```bash
export LEGACY_CURSOR='<pre-cutover legacy cursor>'
HTTP_CODE="$(curl --silent --show-error --get \
  "$ARENA_ORIGIN/api/traders/$ENCODED_TRADER_HANDLE/records" \
  --data-urlencode 'kind=position_history' \
  --data-urlencode "source=$SOURCE_SLUG" \
  --data-urlencode 'tf=90' \
  --data-urlencode "cursor=$LEGACY_CURSOR" \
  --output "$CANARY_DIR/legacy-cursor.json" \
  --write-out '%{http_code}')"
test "$HTTP_CODE" = '409'
jq -e '
  .success == false
  and .error.code == "records_cursor_invalidated"
  and .error.resetRequired == true
' "$CANARY_DIR/legacy-cursor.json"
```

Repeat this bounded sequence for one canary from each reviewed source. Confirm
no new RPC, identity-drift, terminal-verifier/envelope, Storage/RAW admission,
HMAC-cursor, or Tier-B retry spike before declaring the rollout complete and
unfreezing `main`.

The first verified publication is the per-identity authority switch. It does not
bulk-promote legacy rows, and an identity that has switched must never fall back
to legacy data after a later inconsistency.

## Failure and rollback

- **A migration statement or its in-transaction postflight fails:** PostgreSQL
  automatically rolls back that whole migration transaction. Stop and prove
  both its exact ledger row and every authority object are absent before the
  same reviewed one-shot file is retried. A timeout or MCP error message is not
  absence. Any partial/body/catalog disagreement is an incident requiring a
  newly reviewed forward repair.
- **A worker deployment fails before its cutover proves success:** the deployment
  script may restore and prove the complete previous directory while it still
  owns its lease. Keep the other region and the application unchanged, preserve
  all RAW/admission/publication outcomes, fix the cause, and deploy the same
  still-current `CANDIDATE_SHA` again.
- **The Gate promotes the application and its immediate smoke fails:** the Gate
  may temporarily promote the exact previously serving Vercel deployment to
  contain 2C impact. That creates an acknowledged app-versus-worker/schema
  mismatch; it is not a completed rollback and must not become steady state.
  Freeze traffic changes, preserve both deployment identities, and prepare a
  reviewed forward fix or revert commit.
- **Any worker cutover has succeeded, any verified publication exists, or the
  application cutover completed:** never manually redeploy/promote an old SHA as
  the recovery. Recovery code must be a reviewed revert or forward commit that
  becomes the exact current `main`; rerun the controlled worker and application
  release paths from that SHA. Database correction likewise uses a new reviewed
  single-file forward compensating migration and must preserve published
  identities or fail them closed.
- **A canary fails:** stop the rollout and keep the merge/deploy/schema freeze.
  Do not retry with newly prepared publication bytes, choose a different “latest”
  row, rebase a cursor, or overwrite immutable evidence. Reconcile the exact
  `source_run_id` before deciding on a reviewed current-main recovery.
- Never use `migration repair --status reverted`, delete a migration-ledger row,
  manually edit immutable evidence, or run an improvised down migration. A
  deliberately chosen PITR is a disaster-recovery incident, not a migration
  rollback: it restores the whole database to a time and discards every later
  production write, including unrelated 2C state.

## Trust boundary

The trusted computing base includes each reviewed source adapter's pagination
and RAW response-envelope capture, the source-specific terminal verifier, the
history-evidence/envelope builder, the TypeScript publication preparer and its
`arena.strict-canonical-json@1` serializer, the Storage upload plus durable RAW
pointer/admission transaction, and the PostgreSQL publication/serving
authority. A bug in terminal-page cardinality, chronology/overlap observation,
response-envelope capture, Storage bytes, identity binding, or canonical
serialization can therefore invalidate the claim even when later hashes match.

PostgreSQL rechecks bounded shape, exact supplied text hashes, duplicate-key
rejection, reviewed source/RAW/admission relationships, the terminal cardinality,
chronology, and cursor-overlap invariants represented at its metadata/RPC
boundary, ECMAScript Number spelling, row/count identities, publication
linearity, and transactional consistency. The acquisition table copies the
admitted RAW metadata and Storage pointer so normal RAW pointer/Storage retention
cannot silently change an already published serving claim. Operational retention
and disaster recovery must nevertheless preserve the referenced Storage
evidence for its required audit lifetime.

Those checks do not make every source-specific terminal claim an independent
database proof. Binance opening-versus-closing identity-set equality depends on
verifier-only RAW bytes that are not copied into the publication RPC. Binance
`total`, Bitget `nextFlag`, and request-URL or response-envelope-only fields are
also reproduced by the reviewed TypeScript terminal verifier, not independently
reconstructed from the stored binding rows by PostgreSQL. These claims remain
explicitly inside the adapter/verifier TCB even though the database validates
the admitted envelope, registered verifier contract, and terminal consequences
that are present at its boundary.

PostgreSQL does not independently prove that arbitrary input bytes were emitted
by the reviewed adapter or exact ECMAScript canonicalizer, so this design must
not be described as an independent second parser or canonical-JSON
implementation.

`SECURITY DEFINER`, forced RLS, revoked API-role grants, transaction guards, and
ALWAYS triggers protect the normal app/worker paths and catch buggy or
unauthorized mutations while those controls remain installed. “Owner-only”
means the publication function is unavailable to API roles. It is not a defense
against a malicious or compromised `postgres`/superuser or migration channel,
which can alter or disable the controls; the serialized, reviewed MCP channel is
therefore part of the operational trust boundary.
