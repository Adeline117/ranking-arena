#!/usr/bin/env bash

# Isolated PostgreSQL 17 proof for the exact copier source/verifier authority.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260804054700_bind_copier_snapshot_source_authority.sql"
PUBLISHER_MIGRATION="$ROOT_DIR/supabase/migrations/20260804054300_copier_snapshot_lane_v2_authority.sql"
SUBSTRATE_MIGRATION="$ROOT_DIR/supabase/migrations/20260804053000_copier_snapshot_publication_substrate.sql"
CONTAINMENT_MIGRATION="$ROOT_DIR/supabase/migrations/20260804052000_fail_closed_unbound_copier_aggregates.sql"
PROVENANCE_MIGRATION="$ROOT_DIR/supabase/migrations/20260804054200_harden_copier_snapshot_receipt_provenance.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ "$("$PG_BIN/psql" --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo 'This integration proof requires PostgreSQL 17' >&2
  exit 1
fi
if [[ ! -f "$MIGRATION" ]]; then
  echo "Required migration not found: $MIGRATION" >&2
  exit 1
fi
for required_migration in \
  "$PUBLISHER_MIGRATION" \
  "$SUBSTRATE_MIGRATION" \
  "$CONTAINMENT_MIGRATION" \
  "$PROVENANCE_MIGRATION"; do
  if [[ ! -f "$required_migration" ]]; then
    echo "Required historical migration not found: $required_migration" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/copier-source-authority-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((56000 + ($$ % 7000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -200 "$LOG_FILE" >&2 || true
  fi
  if [[ -d "$TMP_ROOT" ]]; then
    find "$TMP_ROOT" -depth -delete
  fi
  exit "$exit_code"
}
trap cleanup EXIT

psql_db() {
  local database="$1"
  shift
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -U postgres -d "$database" "$@"
}

# The isolated fixture intentionally models only the narrow catalog surface
# that 0547 attests. Historical bodies refer to additional production columns;
# loading their exact DDL with body validation disabled preserves their catalog
# definition without replacing the proof with permissive stand-ins.
psql_db_unchecked() {
  local database="$1"
  shift
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -U postgres -d "$database" \
    -c 'SET check_function_bodies=off' "$@"
}

assert_equal() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [[ "$expected" != "$actual" ]]; then
    echo "$label changed: expected '$expected', got '$actual'" >&2
    exit 1
  fi
}

expect_migration_failure() {
  local database="$1"
  local label="$2"
  local needle="$3"
  local failure_log="$TMP_ROOT/${label//[^a-zA-Z0-9_-]/_}.log"
  if psql_db "$database" -q -f "$MIGRATION" >"$failure_log" 2>&1; then
    echo "$label succeeded unexpectedly" >&2
    exit 1
  fi
  if ! grep -Fq "$needle" "$failure_log"; then
    echo "$label failed for an unexpected reason" >&2
    sed -n '1,180p' "$failure_log" >&2
    exit 1
  fi
  psql_db postgres -q -c "DROP DATABASE \"$database\" WITH (FORCE)"
}

expect_sql_failure() {
  local database="$1"
  local label="$2"
  local needle="$3"
  local sql="$4"
  local failure_log="$TMP_ROOT/${label//[^a-zA-Z0-9_-]/_}.log"
  if psql_db "$database" -q -c "$sql" >"$failure_log" 2>&1; then
    echo "$label succeeded unexpectedly" >&2
    exit 1
  fi
  if ! grep -Fq "$needle" "$failure_log"; then
    echo "$label failed for an unexpected reason" >&2
    sed -n '1,180p' "$failure_log" >&2
    exit 1
  fi
}

clone_database() {
  local database="$1"
  psql_db postgres -q -c \
    "CREATE DATABASE \"$database\" TEMPLATE copier_authority_template"
}

clone_installed_database() {
  local database="$1"
  psql_db postgres -q -c \
    "CREATE DATABASE \"$database\" TEMPLATE authority_ok"
}

"$PG_BIN/initdb" \
  -D "$DATA_DIR" \
  --username=postgres \
  --auth-local=trust \
  --auth-host=trust \
  --encoding=UTF8 \
  --wal-segsize=1 \
  --no-sync \
  --no-locale >/dev/null
"$PG_BIN/pg_ctl" \
  -D "$DATA_DIR" \
  -l "$LOG_FILE" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses= -c min_wal_size=2MB -c max_wal_size=8MB -c wal_level=minimal -c max_wal_senders=0 -c max_replication_slots=0 -c fsync=off -c full_page_writes=off -c synchronous_commit=off" \
  -w start >/dev/null

psql_db postgres -q <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE DATABASE copier_authority_template;
SQL

psql_db copier_authority_template -q <<'SQL'
CREATE SCHEMA arena AUTHORIZATION postgres;

CREATE TABLE arena.exchanges (
  id smallint PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL
);
INSERT INTO arena.exchanges (id, slug, name) VALUES
  (1, 'binance', 'Fixture Exchange'),
  (2, 'bitget', 'Fixture Exchange'),
  (3, 'bitunix', 'Fixture Exchange'),
  (4, 'btcc', 'Fixture Exchange'),
  (5, 'coinex', 'Fixture Exchange'),
  (6, 'gate', 'Fixture Exchange'),
  (7, 'kucoin', 'Fixture Exchange'),
  (8, 'mexc', 'Fixture Exchange'),
  (9, 'okx', 'Fixture Exchange'),
  (10, 'toobit', 'Fixture Exchange'),
  (11, 'xt', 'Fixture Exchange'),
  (12, 'lbank', 'Fixture Exchange'),
  (13, 'other', 'Fixture Exchange');

CREATE TABLE arena.sources (
  id smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  adapter_slug text NOT NULL,
  product_type text NOT NULL,
  trader_kind_scope text NOT NULL,
  currency text NOT NULL,
  copier_table_depth text NOT NULL,
  status text NOT NULL DEFAULT 'inactive',
  serving_mode text NOT NULL DEFAULT 'legacy',
  exchange_id smallint NOT NULL DEFAULT 1 REFERENCES arena.exchanges(id),
  timeframes_native integer[] NOT NULL DEFAULT '{7,30,90}',
  timeframes_derived integer[] NOT NULL DEFAULT '{}'
);

CREATE TABLE arena.traders (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  exchange_trader_id text NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}',
  UNIQUE (source_id, exchange_trader_id)
);

CREATE TABLE arena.raw_objects (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  trader_id bigint REFERENCES arena.traders(id),
  job_type text NOT NULL,
  timeframe integer,
  source_run_id text,
  content_hash text NOT NULL,
  trust_artifact_role text,
  storage_path text NOT NULL,
  bytes bigint NOT NULL DEFAULT 1,
  fetched_at timestamptz NOT NULL,
  quarantined boolean NOT NULL DEFAULT false,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE arena.copier_snapshot_publications (
  publication_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  trader_id bigint NOT NULL REFERENCES arena.traders(id),
  source_depth text NOT NULL,
  currency text NOT NULL,
  terminal_verifier_contract text,
  evidence_contract text NOT NULL,
  publisher_contract text NOT NULL,
  evidence_state text,
  scan_terminal_state text NOT NULL,
  caller_limited boolean NOT NULL,
  blocker_reasons jsonb,
  observed_at timestamptz NOT NULL DEFAULT '2026-08-04 12:00:00+00',
  published_at timestamptz NOT NULL DEFAULT '2026-08-04 12:01:00+00',
  request_sha256 text NOT NULL DEFAULT repeat('c', 64),
  copier_count integer NOT NULL DEFAULT 1,
  parsed_row_count integer NOT NULL DEFAULT 1,
  pnl_distribution jsonb NOT NULL DEFAULT '[]'::jsonb,
  total_copier_pnl numeric NOT NULL DEFAULT 1,
  lane text NOT NULL DEFAULT 'tier_b',
  acquisition_source_run_id text NOT NULL DEFAULT repeat('b', 64),
  source_run_id text NOT NULL DEFAULT repeat('a', 64),
  data_contract text NOT NULL DEFAULT
    'arena.ingest.copier-publication-lane-artifact@1',
  raw_trust_artifact_role_at_publication text NOT NULL DEFAULT
    'copier_snapshot',
  raw_evidence_contract_at_publication text NOT NULL DEFAULT
    'arena.ingest.copier-publication-lane-raw-evidence@1',
  live_raw_object_id bigint
    REFERENCES arena.raw_objects(id) ON DELETE SET NULL,
  raw_content_hash text NOT NULL DEFAULT repeat('a', 64),
  raw_storage_path text NOT NULL DEFAULT 'fixture/copier.json.gz',
  raw_fetched_at timestamptz NOT NULL DEFAULT '2026-08-04 11:59:00+00'
);
CREATE INDEX idx_copier_snapshot_publication_latest
  ON arena.copier_snapshot_publications (
    source_id,
    trader_id,
    observed_at DESC,
    publication_id DESC
  );
ALTER TABLE arena.copier_snapshot_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.copier_snapshot_publications FORCE ROW LEVEL SECURITY;

CREATE TABLE arena.copier_snapshot_rows (
  publication_id bigint NOT NULL REFERENCES arena.copier_snapshot_publications(publication_id)
    ON DELETE CASCADE,
  row_ordinal integer NOT NULL,
  source_event_at timestamptz,
  raw jsonb,
  PRIMARY KEY (publication_id, row_ordinal)
);
ALTER TABLE arena.copier_snapshot_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.copier_snapshot_rows FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE arena.copier_snapshot_publications
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE arena.copier_snapshot_rows
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE arena.copier_snapshot_publications_publication_id_seq
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE arena.capability_seed (
  slug text PRIMARY KEY,
  cap jsonb NOT NULL
);

INSERT INTO arena.sources (
  slug, adapter_slug, product_type, trader_kind_scope, currency,
  copier_table_depth, status, serving_mode
) VALUES
  ('binance_futures','binance','futures','human','USDT','full','active','serving'),
  ('binance_spot','binance','spot','human','USDT','full','inactive','legacy'),
  ('bitget_bots_futures','bitget_bots','futures','bot','USDT','top10','active','serving'),
  ('bitget_bots_spot','bitget_bots','spot','bot','USDT','top10','active','serving'),
  ('bitunix_futures','bitunix','futures','human','USDT','full','inactive','legacy'),
  ('btcc_futures','btcc','futures','human','USDT','full','active','serving'),
  ('coinex_futures','coinex','futures','human','USDT','full','inactive','legacy'),
  ('gate_futures','gate','futures','human','USDT','full','inactive','legacy'),
  ('kucoin_futures','kucoin','futures','mixed','USDT','full','inactive','legacy'),
  ('mexc_futures','mexc','futures','mixed','USDT','full','inactive','legacy'),
  ('okx_futures','okx','futures','human','USDT','top10','blocked_pending_vps','legacy'),
  ('toobit_futures','toobit','futures','human','USDT','full','blocked_pending_vps','legacy'),
  ('xt_futures','xt','futures','human','USDT','full','inactive','legacy'),
  ('lbank_futures','lbank','futures','human','USDT','top3_preview','active','serving'),
  ('bitget_futures','bitget','futures','human','USDT','full','active','serving'),
  ('bitget_spot','bitget','spot','human','USDT','full','active','legacy'),
  ('bitget_cfd','bitget','cfd','human','USDT','full','active','legacy'),
  ('xt_spot','xt','spot','human','USDT','full','inactive','legacy'),
  ('other_source','other','futures','human','USDT','none','active','serving');

UPDATE arena.sources AS source_row
SET exchange_id = exchange_row.id
FROM arena.exchanges AS exchange_row
WHERE exchange_row.slug = CASE source_row.adapter_slug
  WHEN 'bitget_bots' THEN 'bitget'
  ELSE source_row.adapter_slug
END;

INSERT INTO arena.capability_seed (slug, cap)
SELECT
  source_row.slug,
  jsonb_build_object(
    'copierDepth', source_row.copier_table_depth,
    'servingMode', source_row.serving_mode,
    'surfaces', jsonb_build_object(
      'copiers', source_row.slug IN ('bitget_futures', 'lbank_futures')
    )
  )
FROM arena.sources AS source_row;

INSERT INTO arena.traders (source_id, exchange_trader_id)
SELECT id, slug || '-trader'
FROM arena.sources;

CREATE MATERIALIZED VIEW arena.mv_source_capabilities AS
SELECT slug, cap
FROM arena.capability_seed
WHERE slug <> 'btcc_futures';
CREATE UNIQUE INDEX idx_fixture_source_capabilities
  ON arena.mv_source_capabilities(slug);
GRANT SELECT ON arena.mv_source_capabilities TO anon, authenticated;
GRANT ALL ON arena.mv_source_capabilities TO service_role;

CREATE FUNCTION public.arena_source_capabilities()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT COALESCE(jsonb_object_agg(slug, cap), '{}'::jsonb)
  FROM arena.mv_source_capabilities;
$function$;
ALTER FUNCTION public.arena_source_capabilities() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.arena_source_capabilities()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.arena_source_capabilities()
  TO anon, authenticated, service_role;

CREATE FUNCTION public.arena_copier_aggregate(text, text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT NULL::jsonb;
$function$;
ALTER FUNCTION public.arena_copier_aggregate(text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.arena_copier_aggregate(text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.arena_copier_aggregate(text, text)
  TO anon, authenticated, service_role;

SQL

extract_function() {
  local migration="$1"
  local start_pattern="$2"
  local output="$3"
  awk -v start_pattern="$start_pattern" '
    $0 ~ start_pattern { emit=1 }
    emit { print }
    emit && /^\$function\$;$/ { exit }
  ' "$migration" >"$output"
  if ! grep -Fq '$function$;' "$output"; then
    echo "Failed to extract historical function from $migration" >&2
    exit 1
  fi
}

LEGACY_PUBLICATION_GUARD_SQL="$TMP_ROOT/legacy-publication-guard.sql"
LEGACY_ROW_GUARD_SQL="$TMP_ROOT/legacy-row-guard.sql"
LEGACY_RAW_GUARD_SQL="$TMP_ROOT/legacy-raw-guard.sql"
LEGACY_ADMISSION_GUARD_SQL="$TMP_ROOT/legacy-admission-guard.sql"
LEGACY_ROW_NORMALIZER_SQL="$TMP_ROOT/legacy-row-normalizer.sql"
LEGACY_READER_SQL="$TMP_ROOT/legacy-reader.sql"

extract_function \
  "$SUBSTRATE_MIGRATION" \
  '^CREATE FUNCTION arena\\.reject_copier_snapshot_publication_mutation\\(' \
  "$LEGACY_PUBLICATION_GUARD_SQL"
extract_function \
  "$SUBSTRATE_MIGRATION" \
  '^CREATE FUNCTION arena\\.reject_copier_snapshot_row_mutation\\(' \
  "$LEGACY_ROW_GUARD_SQL"
extract_function \
  "$SUBSTRATE_MIGRATION" \
  '^CREATE FUNCTION arena\\.protect_copier_snapshot_raw_object\\(' \
  "$LEGACY_RAW_GUARD_SQL"
extract_function \
  "$PROVENANCE_MIGRATION" \
  '^CREATE OR REPLACE FUNCTION arena\\.guard_copier_snapshot_publication_insert_v1\\(' \
  "$LEGACY_ADMISSION_GUARD_SQL"
extract_function \
  "$PROVENANCE_MIGRATION" \
  '^CREATE OR REPLACE FUNCTION arena\\.normalize_copier_snapshot_row_source_event_v1\\(' \
  "$LEGACY_ROW_NORMALIZER_SQL"
extract_function \
  "$CONTAINMENT_MIGRATION" \
  '^CREATE OR REPLACE FUNCTION public\\.arena_copier_aggregate\\(' \
  "$LEGACY_READER_SQL"

for historical_function in \
  "$LEGACY_PUBLICATION_GUARD_SQL" \
  "$LEGACY_ROW_GUARD_SQL" \
  "$LEGACY_RAW_GUARD_SQL" \
  "$LEGACY_ADMISSION_GUARD_SQL" \
  "$LEGACY_ROW_NORMALIZER_SQL" \
  "$LEGACY_READER_SQL"; do
  psql_db_unchecked copier_authority_template -q -f "$historical_function"
done

psql_db copier_authority_template -q <<'SQL'
ALTER FUNCTION arena.reject_copier_snapshot_publication_mutation()
  OWNER TO postgres;
ALTER FUNCTION arena.reject_copier_snapshot_row_mutation()
  OWNER TO postgres;
ALTER FUNCTION arena.protect_copier_snapshot_raw_object()
  OWNER TO postgres;
ALTER FUNCTION arena.guard_copier_snapshot_publication_insert_v1()
  OWNER TO postgres;
ALTER FUNCTION arena.normalize_copier_snapshot_row_source_event_v1()
  OWNER TO postgres;

REVOKE ALL ON FUNCTION arena.reject_copier_snapshot_publication_mutation()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.reject_copier_snapshot_row_mutation()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.protect_copier_snapshot_raw_object()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.guard_copier_snapshot_publication_insert_v1()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.normalize_copier_snapshot_row_source_event_v1()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER copier_snapshot_publication_reject_update_delete
BEFORE UPDATE OR DELETE ON arena.copier_snapshot_publications
FOR EACH ROW EXECUTE FUNCTION arena.reject_copier_snapshot_publication_mutation();
CREATE TRIGGER copier_snapshot_publication_reject_truncate
BEFORE TRUNCATE ON arena.copier_snapshot_publications
FOR EACH STATEMENT EXECUTE FUNCTION arena.reject_copier_snapshot_publication_mutation();
CREATE TRIGGER copier_snapshot_row_reject_update_delete
BEFORE UPDATE OR DELETE ON arena.copier_snapshot_rows
FOR EACH ROW EXECUTE FUNCTION arena.reject_copier_snapshot_row_mutation();
CREATE TRIGGER copier_snapshot_row_reject_truncate
BEFORE TRUNCATE ON arena.copier_snapshot_rows
FOR EACH STATEMENT EXECUTE FUNCTION arena.reject_copier_snapshot_row_mutation();
CREATE TRIGGER protect_copier_snapshot_raw_before_write
BEFORE UPDATE OR DELETE ON arena.raw_objects
FOR EACH ROW EXECUTE FUNCTION arena.protect_copier_snapshot_raw_object();
CREATE TRIGGER copier_snapshot_publication_guard_insert_v1
BEFORE INSERT ON arena.copier_snapshot_publications
FOR EACH ROW EXECUTE FUNCTION arena.guard_copier_snapshot_publication_insert_v1();
CREATE TRIGGER copier_snapshot_row_normalize_source_event_v1
BEFORE INSERT ON arena.copier_snapshot_rows
FOR EACH ROW EXECUTE FUNCTION arena.normalize_copier_snapshot_row_source_event_v1();

ALTER FUNCTION public.arena_copier_aggregate(text, text) SET SCHEMA arena;
ALTER FUNCTION arena.arena_copier_aggregate(text, text)
  RENAME TO copier_aggregate_legacy_containment_v1;
ALTER FUNCTION arena.copier_aggregate_legacy_containment_v1(text, text)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION arena.copier_aggregate_legacy_containment_v1(text, text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.arena_copier_aggregate(text, text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT NULL::jsonb;
$function$;
ALTER FUNCTION public.arena_copier_aggregate(text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.arena_copier_aggregate(text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.arena_copier_aggregate(text, text)
  TO anon, authenticated, service_role;
SQL

assert_equal \
  'historical legacy receipt guards changed' \
  'acf7bec862e1b3fe59832679e90288934a830399906ea09724d13a2520ca76c2|606531a05dd11e2ff767a2a451c58fd9c23fa72fed6096d2af7684a07632150e|c1928715c82e13dd797afc46b58ded917b61926832e233b0450be36b4f194e40|781f23be3a766207fcd98dbc1dd8c44a1e9c70279793b25fd9216a57089c17fe|ac781e999f77a8a300c7062cfe49babc11a737e0f975dbc827a3b2e36527245e|18b285bc1ff2e2ba29027cd8c192583a54181dac8be4c403c9df95540a98bee9' \
  "$(psql_db copier_authority_template -Atqc "SELECT string_agg(encode(sha256(convert_to(pg_get_functiondef(function_oid),'UTF8')),'hex'),'|' ORDER BY ordinal) FROM (VALUES (1, 'arena.reject_copier_snapshot_publication_mutation()'::regprocedure),(2, 'arena.reject_copier_snapshot_row_mutation()'::regprocedure),(3, 'arena.protect_copier_snapshot_raw_object()'::regprocedure),(4, 'arena.guard_copier_snapshot_publication_insert_v1()'::regprocedure),(5, 'arena.normalize_copier_snapshot_row_source_event_v1()'::regprocedure),(6, 'arena.copier_aggregate_legacy_containment_v1(text,text)'::regprocedure)) AS expected(ordinal, function_oid)")"

psql_db copier_authority_template -q <<'SQL'
INSERT INTO arena.copier_snapshot_publications (
  source_id, trader_id, source_depth, currency, terminal_verifier_contract,
  evidence_contract, publisher_contract, evidence_state,
  scan_terminal_state, caller_limited, blocker_reasons
)
SELECT
  source_row.id, trader_row.id, 'full', 'USDT',
  'arena.ingest.history-terminal-verifier.binance.copiers@2',
  'arena.copier-snapshot-publication@2',
  'arena.ingest.copier-snapshot-publisher@2',
  'verified', 'exhausted', false, '[]'::jsonb
FROM arena.sources AS source_row
JOIN arena.traders AS trader_row ON trader_row.source_id = source_row.id
WHERE source_row.slug = 'binance_futures';
SQL

# Install the exact historical @2 publisher definition whose live catalog is a
# prerequisite of 0547. Extracting the immutable function DDL prevents this
# proof from substituting a permissive fixture publisher for the real authority.
PUBLISHER_SQL="$TMP_ROOT/canonical-copier-v2-publisher.sql"
awk '
  /^CREATE OR REPLACE FUNCTION public\.publish_copier_snapshot_v2\(/ { emit=1 }
  emit { print }
  emit && /^\$function\$;$/ { exit }
' "$PUBLISHER_MIGRATION" >"$PUBLISHER_SQL"
if ! grep -Fq 'CREATE OR REPLACE FUNCTION public.publish_copier_snapshot_v2(' \
  "$PUBLISHER_SQL" || ! grep -Fq '$function$;' "$PUBLISHER_SQL"; then
  echo 'Failed to extract the canonical V2 publisher definition' >&2
  exit 1
fi
psql_db_unchecked copier_authority_template -q -f "$PUBLISHER_SQL"
psql_db copier_authority_template -q <<'SQL'
ALTER FUNCTION public.publish_copier_snapshot_v2(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.publish_copier_snapshot_v2(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.publish_copier_snapshot_v2(jsonb)
  TO service_role;
SQL
assert_equal \
  'canonical V2 publisher definition changed' \
  '9dd863f6f0ba59c9cb85b3e262c48e5b25ce057b74f121de817e8ebd59356a5d' \
  "$(psql_db copier_authority_template -Atqc "SELECT encode(sha256(convert_to(pg_get_functiondef('public.publish_copier_snapshot_v2(jsonb)'::regprocedure),'UTF8')),'hex')")"

clone_database missing_source
psql_db missing_source -q <<'SQL'
DELETE FROM arena.traders
WHERE source_id = (SELECT id FROM arena.sources WHERE slug='xt_spot');
DELETE FROM arena.sources WHERE slug='xt_spot';
SQL
expect_migration_failure \
  missing_source \
  'missing canonical copier source was accepted' \
  'requires exactly one canonical source per reviewed slug'

clone_database identity_drift
psql_db identity_drift -q -c \
  "UPDATE arena.sources SET trader_kind_scope='human' WHERE slug='mexc_futures'"
expect_migration_failure \
  identity_drift \
  'copier source identity drift was accepted' \
  'copier source identity, currency, or depth contract drifted'

clone_database depth_drift
psql_db depth_drift -q -c \
  "UPDATE arena.sources SET copier_table_depth='top10' WHERE slug='bitget_spot'"
expect_migration_failure \
  depth_drift \
  'copier source pre-depth drift was accepted' \
  'copier source identity, currency, or depth contract drifted'

clone_database unreviewed_depth
psql_db unreviewed_depth -q -c \
  "UPDATE arena.sources SET copier_table_depth='full' WHERE slug='other_source'"
expect_migration_failure \
  unreviewed_depth \
  'unreviewed non-none source was accepted' \
  'an unreviewed source still claims a public copier depth'

clone_database noncanonical_trader_identity
psql_db noncanonical_trader_identity -q -c \
  "UPDATE arena.traders SET exchange_trader_id=' xt_futures-trader ' WHERE source_id=(SELECT id FROM arena.sources WHERE slug='xt_futures')"
expect_migration_failure \
  noncanonical_trader_identity \
  'noncanonical reviewed copier trader identity was accepted' \
  'reviewed copier trader external identity is not canonical'

clone_database raw_trigger_injection
psql_db raw_trigger_injection -q <<'SQL'
CREATE FUNCTION arena.hostile_raw_object_rewriter()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.content_hash := repeat('0', 64);
  RETURN NEW;
END
$function$;
CREATE TRIGGER z_hostile_raw_object_rewriter
BEFORE UPDATE ON arena.raw_objects
FOR EACH ROW EXECUTE FUNCTION arena.hostile_raw_object_rewriter();
SQL
expect_migration_failure \
  raw_trigger_injection \
  'unreviewed RAW evidence trigger was accepted' \
  'copier snapshot RAW trigger inventory drifted'

clone_database old_verifier_receipt
psql_db old_verifier_receipt -q <<'SQL'
ALTER TABLE arena.copier_snapshot_publications
  DISABLE TRIGGER copier_snapshot_publication_reject_update_delete;
UPDATE arena.copier_snapshot_publications
SET terminal_verifier_contract='arena.ingest.history-terminal-verifier.binance.copiers@1';
ALTER TABLE arena.copier_snapshot_publications
  ENABLE TRIGGER copier_snapshot_publication_reject_update_delete;
SQL
expect_migration_failure \
  old_verifier_receipt \
  'old weak verifier receipt was accepted' \
  'existing copier snapshot receipt is outside the reviewed source authority'

clone_database cross_source_receipt
psql_db cross_source_receipt -q <<'SQL'
ALTER TABLE arena.copier_snapshot_publications
  DISABLE TRIGGER copier_snapshot_publication_reject_update_delete;
UPDATE arena.copier_snapshot_publications
SET trader_id=(
  SELECT trader_row.id
  FROM arena.traders AS trader_row
  JOIN arena.sources AS source_row ON source_row.id=trader_row.source_id
  WHERE source_row.slug='other_source'
);
ALTER TABLE arena.copier_snapshot_publications
  ENABLE TRIGGER copier_snapshot_publication_reject_update_delete;
SQL
expect_migration_failure \
  cross_source_receipt \
  'historical cross-source trader receipt was accepted' \
  'existing copier snapshot receipt is outside the reviewed source authority'

clone_database unregistered_receipt
psql_db unregistered_receipt -q <<'SQL'
INSERT INTO arena.copier_snapshot_publications (
  source_id, trader_id, source_depth, currency, terminal_verifier_contract,
  evidence_contract, publisher_contract, evidence_state,
  scan_terminal_state, caller_limited, blocker_reasons
)
SELECT
  source_row.id, trader_row.id, 'top3_preview', 'USDT',
  'arena.ingest.history-terminal-verifier.lbank.copiers@1',
  'arena.copier-snapshot-publication@2',
  'arena.ingest.copier-snapshot-publisher@2',
  'verified', 'exhausted', false, '[]'::jsonb
FROM arena.sources AS source_row
JOIN arena.traders AS trader_row ON trader_row.source_id = source_row.id
WHERE source_row.slug = 'lbank_futures';
SQL
expect_migration_failure \
  unregistered_receipt \
  'unregistered LBank receipt was accepted' \
  'existing copier snapshot receipt is outside the reviewed source authority'

clone_database publication_table_acl_drift
psql_db publication_table_acl_drift -q -c \
  'GRANT INSERT ON arena.copier_snapshot_publications TO service_role'
expect_migration_failure \
  publication_table_acl_drift \
  'first-install publication table ACL drift was repaired' \
  'private copier publication ACL or policy drifted before source authority'

clone_database publication_column_acl_drift
psql_db publication_column_acl_drift -q -c \
  'GRANT SELECT (source_id) ON arena.copier_snapshot_publications TO service_role'
expect_migration_failure \
  publication_column_acl_drift \
  'first-install publication column ACL drift was repaired' \
  'private copier publication ACL or policy drifted before source authority'

clone_database publication_policy_drift
psql_db publication_policy_drift -q -c \
  'CREATE POLICY hostile_publication_read ON arena.copier_snapshot_publications FOR SELECT TO anon USING (true)'
expect_migration_failure \
  publication_policy_drift \
  'first-install publication policy drift was repaired' \
  'private copier publication ACL or policy drifted before source authority'

clone_database publication_sequence_acl_drift
psql_db publication_sequence_acl_drift -q -c \
  'GRANT USAGE ON SEQUENCE arena.copier_snapshot_publications_publication_id_seq TO service_role'
expect_migration_failure \
  publication_sequence_acl_drift \
  'first-install publication sequence ACL drift was repaired' \
  'private copier publication ACL or policy drifted before source authority'

clone_database partial_install
psql_db partial_install -q -c \
  'CREATE TABLE arena.copier_snapshot_source_authorities (source_id smallint)'
expect_migration_failure \
  partial_install \
  'partial source authority install was repaired' \
  'copier snapshot source authority is partially installed'

clone_database missing_publisher
psql_db missing_publisher -q -c \
  'DROP FUNCTION public.publish_copier_snapshot_v2(jsonb)'
expect_migration_failure \
  missing_publisher \
  'missing canonical V2 publisher was accepted' \
  'requires the canonical V2 publisher'

clone_database publisher_body_drift
psql_db publisher_body_drift -q <<'SQL'
CREATE OR REPLACE FUNCTION public.publish_copier_snapshot_v2(p_request jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RETURN NULL;
END
$function$;
SQL
expect_migration_failure \
  publisher_body_drift \
  'drifted canonical V2 publisher body was accepted' \
  'canonical V2 publisher definition or ACL drifted'

clone_database publisher_acl_drift
psql_db publisher_acl_drift -q -c \
  'GRANT EXECUTE ON FUNCTION public.publish_copier_snapshot_v2(jsonb) TO anon'
expect_migration_failure \
  publisher_acl_drift \
  'drifted canonical V2 publisher ACL was accepted' \
  'canonical V2 publisher definition or ACL drifted'

clone_database authority_ok
psql_db authority_ok -q -f "$MIGRATION"

# Test-only cleanup must not weaken the installed invariant. Each use briefly
# disables only the immutable receipt/row guards as postgres, deletes the
# deliberately injected fixture rows, then restores both guards to ALWAYS
# before any subsequent authority assertion.
cleanup_receipts() {
  local predicate="$1"
  psql_db authority_ok -q <<SQL
ALTER TABLE arena.copier_snapshot_publications
  DISABLE TRIGGER copier_snapshot_publication_reject_update_delete;
ALTER TABLE arena.copier_snapshot_rows
  DISABLE TRIGGER copier_snapshot_row_reject_update_delete;
DELETE FROM arena.copier_snapshot_publications
WHERE $predicate;
ALTER TABLE arena.copier_snapshot_rows
  ENABLE ALWAYS TRIGGER copier_snapshot_row_reject_update_delete;
ALTER TABLE arena.copier_snapshot_publications
  ENABLE ALWAYS TRIGGER copier_snapshot_publication_reject_update_delete;
SQL
}

clone_installed_database replay_column_drift
psql_db replay_column_drift -q -c \
  'ALTER TABLE arena.copier_snapshot_source_authorities ALTER COLUMN contract_version TYPE integer'
expect_migration_failure \
  replay_column_drift \
  'registry column drift was repaired on replay' \
  'copier snapshot source authority replay catalog shape drifted'

clone_installed_database replay_policy_drift
psql_db replay_policy_drift -q -c \
  'DROP POLICY owner_copier_snapshot_source_authority_read ON arena.copier_snapshot_source_authorities'
expect_migration_failure \
  replay_policy_drift \
  'registry policy drift was repaired on replay' \
  'copier snapshot source authority replay policy or ACL drifted'

clone_installed_database replay_function_drift
psql_db replay_function_drift -q <<'SQL'
CREATE OR REPLACE FUNCTION
  arena.enforce_copier_snapshot_source_configuration()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RETURN NEW;
END
$function$;
SQL
expect_migration_failure \
  replay_function_drift \
  'guard function drift was repaired on replay' \
  'copier snapshot source authority replay function definition drifted'

clone_installed_database replay_trader_identity_function_drift
psql_db replay_trader_identity_function_drift -q <<'SQL'
CREATE OR REPLACE FUNCTION arena.enforce_copier_snapshot_trader_identity()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$function$;
SQL
expect_migration_failure \
  replay_trader_identity_function_drift \
  'trader identity guard function drift was repaired on replay' \
  'copier snapshot source authority replay function definition drifted'

clone_installed_database replay_trader_identity_acl_drift
psql_db replay_trader_identity_acl_drift -q -c \
  'GRANT EXECUTE ON FUNCTION arena.enforce_copier_snapshot_trader_identity() TO service_role'
expect_migration_failure \
  replay_trader_identity_acl_drift \
  'trader identity guard ACL drift was accepted on replay' \
  'copier snapshot source authority replay function ACL drifted'

clone_installed_database replay_trigger_drift
psql_db replay_trigger_drift -q -c \
  'ALTER TABLE arena.sources DISABLE TRIGGER copier_snapshot_source_configuration_authority'
expect_migration_failure \
  replay_trigger_drift \
  'disabled ALWAYS source trigger was repaired on replay' \
  'copier snapshot source authority replay triggers drifted'

clone_installed_database replay_trader_identity_trigger_drift
psql_db replay_trader_identity_trigger_drift -q -c \
  'ALTER TABLE arena.traders DISABLE TRIGGER copier_snapshot_trader_identity_authority'
expect_migration_failure \
  replay_trader_identity_trigger_drift \
  'disabled ALWAYS trader identity trigger was repaired on replay' \
  'copier snapshot source authority replay triggers drifted'

clone_installed_database replay_raw_trigger_injection
psql_db replay_raw_trigger_injection -q <<'SQL'
CREATE FUNCTION arena.hostile_replay_raw_object_rewriter()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.content_hash := repeat('0', 64);
  RETURN NEW;
END
$function$;
CREATE TRIGGER z_hostile_replay_raw_object_rewriter
BEFORE UPDATE ON arena.raw_objects
FOR EACH ROW EXECUTE FUNCTION arena.hostile_replay_raw_object_rewriter();
SQL
expect_migration_failure \
  replay_raw_trigger_injection \
  'unreviewed RAW evidence trigger was accepted on replay' \
  'copier snapshot RAW trigger inventory drifted'

clone_installed_database replay_owner_drift
psql_db replay_owner_drift -q -c \
  'ALTER TABLE arena.copier_snapshot_publications OWNER TO service_role'
expect_migration_failure \
  replay_owner_drift \
  'publication owner drift was repaired on replay' \
  'copier source authority foundation owner or RLS drifted'

clone_installed_database replay_column_acl_drift
psql_db replay_column_acl_drift -q -c \
  'GRANT SELECT (source_slug) ON arena.copier_snapshot_source_authorities TO service_role'
expect_migration_failure \
  replay_column_acl_drift \
  'registry column ACL drift was accepted on replay' \
  'copier snapshot source authority replay catalog shape drifted'

clone_installed_database replay_mv_column_acl_drift
psql_db replay_mv_column_acl_drift -q -c \
  'GRANT SELECT (cap) ON arena.mv_source_capabilities TO anon'
expect_migration_failure \
  replay_mv_column_acl_drift \
  'materialized capability column ACL drift was accepted on replay' \
  'copier snapshot direct projection ACL drifted on replay'

clone_installed_database replay_publication_column_acl_drift
psql_db replay_publication_column_acl_drift -q -c \
  'GRANT SELECT (source_id) ON arena.copier_snapshot_publications TO service_role'
expect_migration_failure \
  replay_publication_column_acl_drift \
  'publication column ACL drift was accepted on replay' \
  'private copier publication ACL or policy drifted before source authority'

clone_installed_database replay_latest_index_drift
psql_db replay_latest_index_drift -q -c \
  'DROP INDEX arena.idx_copier_snapshot_publication_latest'
expect_migration_failure \
  replay_latest_index_drift \
  'missing latest-receipt index was accepted on replay' \
  'copier snapshot latest-receipt index drifted'

clone_installed_database replay_reader_parallel_drift
psql_db replay_reader_parallel_drift -q -c \
  'ALTER FUNCTION public.arena_copier_aggregate(text,text) PARALLEL SAFE'
expect_migration_failure \
  replay_reader_parallel_drift \
  'reader catalog definition drift was accepted on replay' \
  'copier snapshot source authority replay function definition drifted'

expect_sql_failure \
  authority_ok \
  'anonymous role read the stale materialized capability cache directly' \
  'permission denied' \
  'SET ROLE anon; SELECT * FROM arena.mv_source_capabilities'
expect_sql_failure \
  authority_ok \
  'service role read private copier publications directly' \
  'permission denied' \
  'SET ROLE service_role; SELECT * FROM arena.copier_snapshot_publications'

assert_equal \
  'unsupported copier depths were not corrected' \
  'bitget_cfd|none
bitget_futures|none
bitget_spot|none
xt_spot|none' \
  "$(psql_db authority_ok -Atqc "SELECT slug || '|' || copier_table_depth FROM arena.sources WHERE slug IN ('bitget_cfd','bitget_futures','bitget_spot','xt_spot') ORDER BY slug")"

assert_equal \
  'LBank preview or non-publication registry contract drifted' \
  'top3_preview|1|false|true' \
  "$(psql_db authority_ok -Atqc "SELECT source_row.copier_table_depth || '|' || count(authority.source_id) || '|' || min(authority.publication_eligible::text) || '|' || bool_and(authority.terminal_verifier_contract IS NULL)::text FROM arena.sources AS source_row LEFT JOIN arena.copier_snapshot_source_authorities AS authority ON authority.source_id=source_row.id WHERE source_row.slug='lbank_futures' GROUP BY source_row.copier_table_depth")"

assert_equal \
  'exact authority registry cardinality or verifier versions drifted' \
  '14|13|0|1' \
  "$(psql_db authority_ok -Atqc "SELECT count(*) || '|' || count(*) FILTER (WHERE terminal_verifier_contract ~ '@[23]$') || '|' || count(*) FILTER (WHERE terminal_verifier_contract = 'arena.ingest.history-terminal-verifier.bitget_bots.copiers@1') || '|' || count(*) FILTER (WHERE NOT publication_eligible) FROM arena.copier_snapshot_source_authorities")"

assert_equal \
  'valid existing receipt was not preserved' \
  '1' \
  "$(psql_db authority_ok -Atqc 'SELECT count(*) FROM arena.copier_snapshot_publications')"

# A stale MV false is overlaid by the exact current receipt. Stale legacy true
# values for a corrected depth and the unregistered LBank preview are hidden.
assert_equal \
  'receipt-bound capability overlay drifted' \
  'binance_futures|full|true
bitget_futures|none|false
lbank_futures|top3_preview|false' \
  "$(psql_db authority_ok -Atqc "WITH caps AS (SELECT public.arena_source_capabilities() AS payload) SELECT target.slug || '|' || (caps.payload->target.slug->>'copierDepth') || '|' || (caps.payload->target.slug->'surfaces'->>'copiers') FROM caps CROSS JOIN (VALUES ('binance_futures'),('bitget_futures'),('lbank_futures')) AS target(slug) ORDER BY target.slug")"

# Treat the materialized capability payload as an untrusted cache. A JSON array
# must not alter the object merge or hide the live authority markers.
psql_db authority_ok -q <<'SQL'
UPDATE arena.capability_seed
SET cap='[]'::jsonb
WHERE slug='binance_futures';
REFRESH MATERIALIZED VIEW arena.mv_source_capabilities;
SQL
assert_equal \
  'malformed materialized capability payload crossed the live overlay' \
  'object|Fixture Exchange|true|arena.copier-snapshot-source-authority@1' \
  "$(psql_db authority_ok -Atqc "WITH caps AS (SELECT public.arena_source_capabilities() AS payload) SELECT jsonb_typeof(caps.payload->'binance_futures') || '|' || (caps.payload->'binance_futures'->>'exchangeName') || '|' || (caps.payload->'binance_futures'->'surfaces'->>'copiers') || '|' || (caps.payload->'binance_futures'->>'copierAuthorityContract') FROM caps")"

assert_equal \
  'exact current V2 anonymous reader projection drifted' \
  'true|full|1|arena.copier-snapshot-receipt-reader@4' \
  "$(psql_db authority_ok -Atqc "SET ROLE anon; SELECT (public.arena_copier_aggregate('binance_futures','binance_futures-trader')->>'receiptBound') || '|' || (public.arena_copier_aggregate('binance_futures','binance_futures-trader')->>'depth') || '|' || (public.arena_copier_aggregate('binance_futures','binance_futures-trader')->>'copierCount') || '|' || (public.arena_copier_aggregate('binance_futures','binance_futures-trader')->>'receiptReaderContract')")"

assert_equal \
  'unregistered reader subjects did not fail closed' \
  'true|true' \
  "$(psql_db authority_ok -Atqc "SET ROLE anon; SELECT (public.arena_copier_aggregate('lbank_futures','lbank_futures-trader') IS NULL)::text || '|' || (public.arena_copier_aggregate('other_source','other_source-trader') IS NULL)::text")"

# A hostile historical row whose trader belongs to another source must not
# light capability even when every source-level authority coordinate is exact.
psql_db authority_ok -q <<'SQL'
UPDATE arena.sources
SET status='active', serving_mode='serving'
WHERE slug='coinex_futures';
ALTER TABLE arena.copier_snapshot_publications
  DISABLE TRIGGER copier_snapshot_publication_00_source_authority;
ALTER TABLE arena.copier_snapshot_publications
  DISABLE TRIGGER copier_snapshot_publication_guard_insert_v1;
INSERT INTO arena.copier_snapshot_publications (
  source_id, trader_id, source_depth, currency, terminal_verifier_contract,
  evidence_contract, publisher_contract, evidence_state,
  scan_terminal_state, caller_limited, blocker_reasons
)
SELECT coinex.id, foreign_trader.id, 'full', 'USDT',
  'arena.ingest.history-terminal-verifier.coinex.copiers@2',
  'arena.copier-snapshot-publication@2',
  'arena.ingest.copier-snapshot-publisher@2',
  'verified', 'exhausted', false, '[]'::jsonb
FROM arena.sources AS coinex
CROSS JOIN LATERAL (
  SELECT trader_row.id
  FROM arena.traders AS trader_row
  JOIN arena.sources AS source_row ON source_row.id=trader_row.source_id
  WHERE source_row.slug='binance_futures'
) AS foreign_trader
WHERE coinex.slug='coinex_futures';
ALTER TABLE arena.copier_snapshot_publications
  ENABLE ALWAYS TRIGGER copier_snapshot_publication_00_source_authority;
ALTER TABLE arena.copier_snapshot_publications
  ENABLE ALWAYS TRIGGER copier_snapshot_publication_guard_insert_v1;
SQL
assert_equal \
  'cross-source trader receipt diverged capability from the reader' \
  'false|true' \
  "$(psql_db authority_ok -Atqc "WITH caps AS (SELECT public.arena_source_capabilities() AS payload) SELECT (caps.payload->'coinex_futures'->'surfaces'->>'copiers') || '|' || (public.arena_copier_aggregate('coinex_futures','coinex_futures-trader') IS NULL)::text FROM caps")"
cleanup_receipts "source_id=(SELECT id FROM arena.sources WHERE slug='coinex_futures')"
psql_db authority_ok -q <<'SQL'
UPDATE arena.sources
SET status='inactive', serving_mode='legacy'
WHERE slug='coinex_futures';
SQL

# The source-level capability must follow the reader's latest-per-trader rule.
# Injecting a newer invalid candidate with the ALWAYS guard deliberately
# disabled must hide both the tab and the aggregate rather than exposing the
# older valid receipt.
psql_db authority_ok -q <<'SQL'
ALTER TABLE arena.copier_snapshot_publications
  DISABLE TRIGGER copier_snapshot_publication_00_source_authority;
INSERT INTO arena.copier_snapshot_publications (
  source_id, trader_id, source_depth, currency, terminal_verifier_contract,
  evidence_contract, publisher_contract, evidence_state,
  scan_terminal_state, caller_limited, blocker_reasons,
  observed_at, published_at
)
SELECT source_row.id, trader_row.id, 'full', 'USDT',
  'arena.ingest.history-terminal-verifier.binance.copiers@1',
  'arena.copier-snapshot-publication@2',
  'arena.ingest.copier-snapshot-publisher@2',
  'verified', 'exhausted', false, '[]'::jsonb,
  '2026-08-04 13:00:00+00', '2026-08-04 13:01:00+00'
FROM arena.sources AS source_row
JOIN arena.traders AS trader_row ON trader_row.source_id=source_row.id
WHERE source_row.slug='binance_futures';
ALTER TABLE arena.copier_snapshot_publications
  ENABLE ALWAYS TRIGGER copier_snapshot_publication_00_source_authority;
SQL
assert_equal \
  'latest invalid receipt did not hide capability and reader' \
  'false|true' \
  "$(psql_db authority_ok -Atqc "WITH caps AS (SELECT public.arena_source_capabilities() AS payload) SELECT (caps.payload->'binance_futures'->'surfaces'->>'copiers') || '|' || (public.arena_copier_aggregate('binance_futures','binance_futures-trader') IS NULL)::text FROM caps")"
cleanup_receipts "terminal_verifier_contract='arena.ingest.history-terminal-verifier.binance.copiers@1'"

psql_db authority_ok -q <<'SQL'
CREATE FUNCTION public.fixture_publish_copier_receipt(
  p_source_slug text,
  p_depth text,
  p_currency text,
  p_verifier text,
  p_evidence text,
  p_publisher text
)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_publication_id bigint;
BEGIN
  WITH subject AS (
    SELECT source_row.id AS source_id, trader_row.id AS trader_id
    FROM ONLY arena.sources AS source_row
    JOIN ONLY arena.traders AS trader_row
      ON trader_row.source_id = source_row.id
    WHERE source_row.slug = p_source_slug
  ), inserted_raw AS (
    INSERT INTO arena.raw_objects (
      source_id, trader_id, job_type, timeframe, source_run_id, content_hash,
      trust_artifact_role, storage_path, bytes, fetched_at, quarantined, meta
    )
    SELECT
      subject.source_id,
      subject.trader_id,
      'history:copiers',
      NULL,
      repeat('a', 64),
      repeat('a', 64),
      'copier_snapshot',
      'fixture/copier.json.gz',
      1,
      '2026-08-04 11:59:00+00'::timestamptz,
      false,
      jsonb_build_object(
        'source_run_id', repeat('a', 64),
        'publication_lane', 'tier_b',
        'acquisition_source_run_id', repeat('b', 64),
        'data_contract', 'arena.ingest.copier-publication-lane-artifact@1',
        'publication_evidence_contract',
          'arena.ingest.copier-publication-lane-raw-evidence@1'
      )
    FROM subject
    RETURNING id
  )
  INSERT INTO arena.copier_snapshot_publications (
    source_id, trader_id, source_depth, currency, terminal_verifier_contract,
    evidence_contract, publisher_contract, evidence_state,
    scan_terminal_state, caller_limited, blocker_reasons, live_raw_object_id,
    source_run_id, acquisition_source_run_id, raw_content_hash,
    raw_storage_path, raw_fetched_at
  )
  SELECT
    subject.source_id,
    subject.trader_id,
    p_depth,
    p_currency,
    p_verifier,
    p_evidence,
    p_publisher,
    'verified',
    'exhausted',
    false,
    '[]'::jsonb,
    inserted_raw.id,
    repeat('a', 64),
    repeat('b', 64),
    repeat('a', 64),
    'fixture/copier.json.gz',
    '2026-08-04 11:59:00+00'::timestamptz
  FROM subject
  CROSS JOIN inserted_raw
  RETURNING publication_id INTO v_publication_id;

  RETURN v_publication_id;
END
$function$;
ALTER FUNCTION public.fixture_publish_copier_receipt(text,text,text,text,text,text)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION
  public.fixture_publish_copier_receipt(text,text,text,text,text,text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  public.fixture_publish_copier_receipt(text,text,text,text,text,text)
  TO service_role;
SQL

expect_sql_failure \
  authority_ok \
  'cross-source trader direct publication was accepted' \
  'has no exact active-serving source authority' \
  "INSERT INTO arena.copier_snapshot_publications (source_id,trader_id,source_depth,currency,terminal_verifier_contract,evidence_contract,publisher_contract,evidence_state,scan_terminal_state,caller_limited,blocker_reasons) SELECT source_row.id,trader_row.id,'full','USDT','arena.ingest.history-terminal-verifier.btcc.copiers@2','arena.copier-snapshot-publication@2','arena.ingest.copier-snapshot-publisher@2','verified','exhausted',false,'[]'::jsonb FROM arena.sources AS source_row CROSS JOIN arena.traders AS trader_row WHERE source_row.slug='btcc_futures' AND trader_row.source_id=(SELECT id FROM arena.sources WHERE slug='binance_futures')"

# Publication-first ordering: the INSERT authority takes FOR SHARE on the
# canonical trader row. An external identity rewrite must wait, then the
# immutable ALWAYS identity trigger must reject it after the receipt commits.
psql_db authority_ok -q -c \
  "UPDATE arena.sources SET status='active', serving_mode='serving' WHERE slug='xt_futures'"
(
  psql_db authority_ok -q <<'SQL'
SET application_name='copier-authority-publication-first';
BEGIN;
SET ROLE service_role;
SELECT public.fixture_publish_copier_receipt(
  'xt_futures',
  'full',
  'USDT',
  'arena.ingest.history-terminal-verifier.xt.copiers@2',
  'arena.copier-snapshot-publication@2',
  'arena.ingest.copier-snapshot-publisher@2'
);
RESET ROLE;
SELECT pg_catalog.pg_sleep(1.5);
COMMIT;
SQL
) >"$TMP_ROOT/publication-first-race.log" 2>&1 &
publication_first_pid=$!
publication_first_ready=false
for _ in $(seq 1 100); do
  if [[ "$(psql_db authority_ok -Atqc "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity WHERE application_name='copier-authority-publication-first' AND wait_event='PgSleep')")" == 't' ]]; then
    publication_first_ready=true
    break
  fi
  sleep 0.05
done
if [[ "$publication_first_ready" != true ]]; then
  wait "$publication_first_pid" || true
  sed -n '1,160p' "$TMP_ROOT/publication-first-race.log" >&2
  echo 'publication-first identity race did not reach its lock-holding probe' >&2
  exit 1
fi
expect_sql_failure \
  authority_ok \
  'trader rename did not serialize behind an in-flight publication' \
  'canceling statement due to statement timeout' \
  "SET statement_timeout='500ms'; UPDATE arena.traders SET exchange_trader_id='xt-futures-renamed' WHERE exchange_trader_id='xt_futures-trader'"
wait "$publication_first_pid"
expect_sql_failure \
  authority_ok \
  'trader rename succeeded after a publication committed' \
  'registered copier trader identity is immutable' \
  "UPDATE arena.traders SET exchange_trader_id='xt-futures-renamed' WHERE exchange_trader_id='xt_futures-trader'"
assert_equal \
  'publication-first race reassigned an immutable receipt' \
  '1|true|true' \
  "$(psql_db authority_ok -Atqc "SELECT count(*) || '|' || (public.arena_copier_aggregate('xt_futures','xt_futures-trader') IS NOT NULL)::text || '|' || (public.arena_copier_aggregate('xt_futures','xt-futures-renamed') IS NULL)::text FROM arena.copier_snapshot_publications WHERE source_id=(SELECT id FROM arena.sources WHERE slug='xt_futures')")"
cleanup_receipts "source_id=(SELECT id FROM arena.sources WHERE slug='xt_futures')"
psql_db authority_ok -q <<'SQL'
UPDATE arena.sources
SET status='inactive', serving_mode='legacy'
WHERE slug='xt_futures';
SQL

# Rename-attempt-first ordering: hold the trader tuple, then attempt the
# forbidden rename while an exact publication waits. The rename transaction
# must abort, releasing the original identity for the publication to recheck.
psql_db authority_ok -q -c \
  "UPDATE arena.sources SET status='active', serving_mode='serving' WHERE slug='kucoin_futures'"
(
  psql_db authority_ok -q <<'SQL'
SET application_name='copier-authority-rename-first';
BEGIN;
SELECT trader_row.id
FROM arena.traders AS trader_row
JOIN arena.sources AS source_row ON source_row.id=trader_row.source_id
WHERE source_row.slug='kucoin_futures'
FOR UPDATE OF trader_row;
SELECT pg_catalog.pg_sleep(1.5);
UPDATE arena.traders
SET exchange_trader_id='kucoin-futures-renamed'
WHERE exchange_trader_id='kucoin_futures-trader';
COMMIT;
SQL
) >"$TMP_ROOT/rename-first-race.log" 2>&1 &
rename_first_pid=$!
rename_first_ready=false
for _ in $(seq 1 100); do
  if [[ "$(psql_db authority_ok -Atqc "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity WHERE application_name='copier-authority-rename-first' AND wait_event='PgSleep')")" == 't' ]]; then
    rename_first_ready=true
    break
  fi
  sleep 0.05
done
if [[ "$rename_first_ready" != true ]]; then
  wait "$rename_first_pid" || true
  sed -n '1,160p' "$TMP_ROOT/rename-first-race.log" >&2
  echo 'rename-first identity race did not reach its lock-holding probe' >&2
  exit 1
fi
assert_equal \
  'publication did not survive a serialized rejected rename attempt' \
  'true' \
  "$(psql_db authority_ok -Atqc "SET ROLE service_role; SELECT (public.fixture_publish_copier_receipt('kucoin_futures','full','USDT','arena.ingest.history-terminal-verifier.kucoin.copiers@2','arena.copier-snapshot-publication@2','arena.ingest.copier-snapshot-publisher@2') IS NOT NULL)::text")"
if wait "$rename_first_pid"; then
  echo 'rename-first identity transaction succeeded unexpectedly' >&2
  exit 1
fi
if ! grep -Fq 'registered copier trader identity is immutable' \
  "$TMP_ROOT/rename-first-race.log"; then
  sed -n '1,160p' "$TMP_ROOT/rename-first-race.log" >&2
  echo 'rename-first identity transaction failed for an unexpected reason' >&2
  exit 1
fi
assert_equal \
  'rename-first race reassigned an immutable receipt' \
  '1|true|true' \
  "$(psql_db authority_ok -Atqc "SELECT count(*) || '|' || (public.arena_copier_aggregate('kucoin_futures','kucoin_futures-trader') IS NOT NULL)::text || '|' || (public.arena_copier_aggregate('kucoin_futures','kucoin-futures-renamed') IS NULL)::text FROM arena.copier_snapshot_publications WHERE source_id=(SELECT id FROM arena.sources WHERE slug='kucoin_futures')")"
cleanup_receipts "source_id=(SELECT id FROM arena.sources WHERE slug='kucoin_futures')"
psql_db authority_ok -q <<'SQL'
UPDATE arena.sources
SET status='inactive', serving_mode='legacy'
WHERE slug='kucoin_futures';
SQL

# A demotion that owns the mutable source row must serialize before an exact
# publication. Without the authority trigger's FOR SHARE, the publisher would
# read the old active tuple and mint a receipt while demotion is uncommitted.
psql_db authority_ok -q -c \
  "UPDATE arena.sources SET status='active', serving_mode='serving' WHERE slug='gate_futures'"
(
  psql_db authority_ok -q <<'SQL'
SET application_name='copier-authority-source-demotion';
BEGIN;
UPDATE arena.sources
SET status='inactive', serving_mode='legacy'
WHERE slug='gate_futures';
SELECT pg_catalog.pg_sleep(1.5);
COMMIT;
SQL
) >"$TMP_ROOT/source-demotion-race.log" 2>&1 &
demotion_pid=$!
demotion_ready=false
for _ in $(seq 1 100); do
  if [[ "$(psql_db authority_ok -Atqc "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity WHERE application_name='copier-authority-source-demotion' AND wait_event='PgSleep')")" == 't' ]]; then
    demotion_ready=true
    break
  fi
  sleep 0.05
done
if [[ "$demotion_ready" != true ]]; then
  wait "$demotion_pid" || true
  sed -n '1,160p' "$TMP_ROOT/source-demotion-race.log" >&2
  echo 'concurrent source demotion did not reach its lock-holding probe' >&2
  exit 1
fi
expect_sql_failure \
  authority_ok \
  'publication raced through a concurrent source demotion' \
  'has no exact active-serving source authority' \
  "SET ROLE service_role; SELECT public.fixture_publish_copier_receipt('gate_futures','full','USDT','arena.ingest.history-terminal-verifier.gate.copiers@2','arena.copier-snapshot-publication@2','arena.ingest.copier-snapshot-publisher@2')"
wait "$demotion_pid"
assert_equal \
  'concurrent source demotion minted a stale-authority receipt' \
  'inactive|legacy|0' \
  "$(psql_db authority_ok -Atqc "SELECT source_row.status || '|' || source_row.serving_mode || '|' || count(publication.publication_id) FROM arena.sources AS source_row LEFT JOIN arena.copier_snapshot_publications AS publication ON publication.source_id=source_row.id WHERE source_row.slug='gate_futures' GROUP BY source_row.status, source_row.serving_mode")"
psql_db authority_ok -q -c \
  "UPDATE arena.sources SET status='active', serving_mode='serving' WHERE slug='gate_futures'"

assert_equal \
  'exact service-role RPC receipt was rejected' \
  'true' \
  "$(psql_db authority_ok -Atqc "SET ROLE service_role; SELECT (public.fixture_publish_copier_receipt('btcc_futures','full','USDT','arena.ingest.history-terminal-verifier.btcc.copiers@2','arena.copier-snapshot-publication@2','arena.ingest.copier-snapshot-publisher@2') IS NOT NULL)::text")"

expect_sql_failure \
  authority_ok \
  'replica-mode exact publication rewrite bypassed immutability' \
  'publication receipts are immutable under source authority' \
  "SET session_replication_role=replica; UPDATE arena.copier_snapshot_publications SET source_depth=source_depth WHERE source_id=(SELECT id FROM arena.sources WHERE slug='btcc_futures')"

assert_equal \
  'exact newly published V2 receipt was hidden from the reader' \
  'true|1' \
  "$(psql_db authority_ok -Atqc "SET ROLE authenticated; SELECT (public.arena_copier_aggregate('btcc_futures','btcc_futures-trader')->>'receiptBound') || '|' || (public.arena_copier_aggregate('btcc_futures','btcc_futures-trader')->>'copierCount')")"

# Registry membership freezes every external trader identity, not only traders
# that already have a receipt. Ordinary metadata updates remain O(1), while
# handle/source/PK changes and DELETE are rejected even in replica mode.
psql_db authority_ok -q -c \
  "UPDATE arena.traders SET meta=meta || '{\"nonIdentityUpdate\":true}'::jsonb WHERE exchange_trader_id='btcc_futures-trader'"
assert_equal \
  'ordinary registered trader metadata update was rejected' \
  'true' \
  "$(psql_db authority_ok -Atqc "SELECT (meta->>'nonIdentityUpdate') FROM arena.traders WHERE exchange_trader_id='btcc_futures-trader'")"

expect_sql_failure \
  authority_ok \
  'registered trader handle rename was accepted' \
  'registered copier trader identity is immutable' \
  "UPDATE arena.traders SET exchange_trader_id='btcc-futures-renamed' WHERE exchange_trader_id='btcc_futures-trader'"
expect_sql_failure \
  authority_ok \
  'replica-mode registered trader handle rename was accepted' \
  'registered copier trader identity is immutable' \
  "SET session_replication_role=replica; UPDATE arena.traders SET exchange_trader_id='btcc-futures-renamed' WHERE exchange_trader_id='btcc_futures-trader'"
expect_sql_failure \
  authority_ok \
  'replica-mode registered trader primary-key rewrite was accepted' \
  'registered copier trader identity is immutable' \
  "SET session_replication_role=replica; UPDATE arena.traders SET id=DEFAULT WHERE exchange_trader_id='btcc_futures-trader'"
expect_sql_failure \
  authority_ok \
  'replica-mode registered trader source rebind was accepted' \
  'registered copier trader identity is immutable' \
  "SET session_replication_role=replica; UPDATE arena.traders SET source_id=(SELECT id FROM arena.sources WHERE slug='other_source') WHERE exchange_trader_id='btcc_futures-trader'"
expect_sql_failure \
  authority_ok \
  'registered trader DELETE was accepted' \
  'registered copier trader identity is immutable' \
  "SET session_replication_role=replica; DELETE FROM arena.traders WHERE exchange_trader_id='btcc_futures-trader'"
expect_sql_failure \
  authority_ok \
  'noncanonical registered trader INSERT was accepted' \
  'registered copier trader identity must be canonical' \
  "SET session_replication_role=replica; INSERT INTO arena.traders(source_id,exchange_trader_id) SELECT id,'  ' FROM arena.sources WHERE slug='btcc_futures'"

assert_equal \
  'rejected handle rename reassigned an immutable receipt' \
  'true|true' \
  "$(psql_db authority_ok -Atqc "SET ROLE anon; SELECT (public.arena_copier_aggregate('btcc_futures','btcc_futures-trader') IS NOT NULL)::text || '|' || (public.arena_copier_aggregate('btcc_futures','btcc-futures-renamed') IS NULL)::text")"

assert_equal \
  'valid receipt with no materialized capability row stayed hidden' \
  'full|true|[]|arena.copier-snapshot-source-authority@1' \
  "$(psql_db authority_ok -Atqc "WITH caps AS (SELECT public.arena_source_capabilities() AS payload) SELECT (caps.payload->'btcc_futures'->>'copierDepth') || '|' || (caps.payload->'btcc_futures'->'surfaces'->>'copiers') || '|' || (caps.payload->'btcc_futures'->'metrics')::text || '|' || (caps.payload->'btcc_futures'->>'copierAuthorityContract') FROM caps")"

# RAW quarantine is a live reader boundary and therefore also a capability
# boundary. One exact receipt backed by a live RAW lights the tab, then the
# same immutable receipt disappears from both projections after quarantine.
psql_db authority_ok -q <<'SQL'
UPDATE arena.sources
SET status='active', serving_mode='serving'
WHERE slug='coinex_futures';
WITH subject AS (
  SELECT source_row.id AS source_id, trader_row.id AS trader_id
  FROM arena.sources AS source_row
  JOIN arena.traders AS trader_row ON trader_row.source_id=source_row.id
  WHERE source_row.slug='coinex_futures'
), inserted_raw AS (
  INSERT INTO arena.raw_objects (
    source_id, trader_id, job_type, timeframe, source_run_id, content_hash,
    trust_artifact_role, storage_path, fetched_at, quarantined, meta
  )
  SELECT source_id, trader_id, 'history:copiers', NULL,
    repeat('d',64), repeat('d',64), 'copier_snapshot',
    'coinex_futures/copier.json.gz', '2026-08-04 11:59:00+00', false,
    jsonb_build_object(
      'source_run_id', repeat('d',64),
      'publication_lane', 'tier_b',
      'acquisition_source_run_id', repeat('e',64),
      'data_contract', 'arena.ingest.copier-publication-lane-artifact@1',
      'publication_evidence_contract',
        'arena.ingest.copier-publication-lane-raw-evidence@1'
    )
  FROM subject
  RETURNING id, source_id, trader_id
)
INSERT INTO arena.copier_snapshot_publications (
  source_id, trader_id, source_depth, currency, terminal_verifier_contract,
  evidence_contract, publisher_contract, evidence_state,
  scan_terminal_state, caller_limited, blocker_reasons,
  live_raw_object_id, source_run_id, acquisition_source_run_id,
  raw_content_hash, raw_storage_path, raw_fetched_at
)
SELECT source_id, trader_id, 'full', 'USDT',
  'arena.ingest.history-terminal-verifier.coinex.copiers@2',
  'arena.copier-snapshot-publication@2',
  'arena.ingest.copier-snapshot-publisher@2',
  'verified', 'exhausted', false, '[]'::jsonb,
  id, repeat('d',64), repeat('e',64), repeat('d',64),
  'coinex_futures/copier.json.gz', '2026-08-04 11:59:00+00'
FROM inserted_raw;
SQL
assert_equal \
  'exact live RAW receipt did not light capability and reader' \
  'true|true' \
  "$(psql_db authority_ok -Atqc "WITH caps AS (SELECT public.arena_source_capabilities() AS payload) SELECT (caps.payload->'coinex_futures'->'surfaces'->>'copiers') || '|' || (public.arena_copier_aggregate('coinex_futures','coinex_futures-trader') IS NOT NULL)::text FROM caps")"
psql_db authority_ok -q -c \
  "UPDATE arena.raw_objects SET quarantined=true WHERE source_run_id=repeat('d',64)"
assert_equal \
  'quarantined RAW receipt remained capability- or reader-visible' \
  'false|true' \
  "$(psql_db authority_ok -Atqc "WITH caps AS (SELECT public.arena_source_capabilities() AS payload) SELECT (caps.payload->'coinex_futures'->'surfaces'->>'copiers') || '|' || (public.arena_copier_aggregate('coinex_futures','coinex_futures-trader') IS NULL)::text FROM caps")"

expect_sql_failure \
  authority_ok \
  'quarantined RAW evidence was unquarantined' \
  'copier snapshot RAW evidence' \
  "UPDATE arena.raw_objects SET quarantined=false WHERE source_run_id=repeat('d',64)"
expect_sql_failure \
  authority_ok \
  'replica-mode quarantined RAW evidence was unquarantined' \
  'copier snapshot RAW evidence' \
  "SET session_replication_role=replica; UPDATE arena.raw_objects SET quarantined=false WHERE source_run_id=repeat('d',64)"
expect_sql_failure \
  authority_ok \
  'quarantined RAW evidence was deleted' \
  'quarantined copier snapshot RAW evidence cannot be deleted' \
  "DELETE FROM arena.raw_objects WHERE source_run_id=repeat('d',64)"
psql_db authority_ok -q -c \
  "UPDATE arena.sources SET status='inactive', serving_mode='legacy' WHERE slug='coinex_futures'"
expect_sql_failure \
  authority_ok \
  'direct tombstone bypassed inactive source authority' \
  'publication receipts are immutable under source authority' \
  "UPDATE arena.copier_snapshot_publications SET live_raw_object_id=NULL WHERE source_id=(SELECT id FROM arena.sources WHERE slug='coinex_futures')"
cleanup_receipts "source_id=(SELECT id FROM arena.sources WHERE slug='coinex_futures')"
psql_db authority_ok -q -c \
  "DELETE FROM arena.raw_objects WHERE source_run_id=repeat('d',64)"
psql_db authority_ok -q -c \
  "DELETE FROM arena.raw_objects WHERE id=(SELECT live_raw_object_id FROM arena.copier_snapshot_publications WHERE source_id=(SELECT id FROM arena.sources WHERE slug='btcc_futures') ORDER BY publication_id DESC LIMIT 1)"
assert_equal \
  'nested RAW GC did not preserve the immutable receipt tombstone contract' \
  '1|0' \
  "$(psql_db authority_ok -Atqc "SELECT count(*) || '|' || count(live_raw_object_id) FROM arena.copier_snapshot_publications WHERE source_id=(SELECT id FROM arena.sources WHERE slug='btcc_futures')")"

expect_sql_failure \
  authority_ok \
  'generic arbitrary-source RPC publication was accepted' \
  'has no exact active-serving source authority' \
  "SET ROLE service_role; SELECT public.fixture_publish_copier_receipt('other_source','full','USDT','arena.ingest.history-terminal-verifier.fixture.copiers@1','arena.copier-snapshot-publication@2','arena.ingest.copier-snapshot-publisher@2')"

expect_sql_failure \
  authority_ok \
  'old verifier RPC publication was accepted' \
  'has no exact active-serving source authority' \
  "SET ROLE service_role; SELECT public.fixture_publish_copier_receipt('btcc_futures','full','USDT','arena.ingest.history-terminal-verifier.btcc.copiers@1','arena.copier-snapshot-publication@2','arena.ingest.copier-snapshot-publisher@2')"

expect_sql_failure \
  authority_ok \
  'wrong depth RPC publication was accepted' \
  'has no exact active-serving source authority' \
  "SET ROLE service_role; SELECT public.fixture_publish_copier_receipt('btcc_futures','top10','USDT','arena.ingest.history-terminal-verifier.btcc.copiers@2','arena.copier-snapshot-publication@2','arena.ingest.copier-snapshot-publisher@2')"

expect_sql_failure \
  authority_ok \
  'V1 publication remained writable' \
  'has no exact active-serving source authority' \
  "SET ROLE service_role; SELECT public.fixture_publish_copier_receipt('btcc_futures','full','USDT','arena.ingest.history-terminal-verifier.btcc.copiers@2','arena.copier-snapshot-publication@1','arena.ingest.copier-snapshot-publisher@1')"

expect_sql_failure \
  authority_ok \
  'LBank preview published through direct RPC' \
  'has no exact active-serving source authority' \
  "SET ROLE service_role; SELECT public.fixture_publish_copier_receipt('lbank_futures','top3_preview','USDT','arena.ingest.history-terminal-verifier.lbank.copiers@1','arena.copier-snapshot-publication@2','arena.ingest.copier-snapshot-publisher@2')"

expect_sql_failure \
  authority_ok \
  'unreviewed source depth activation was accepted' \
  'source has no exact copier snapshot source authority' \
  "UPDATE arena.sources SET copier_table_depth='full' WHERE slug='other_source'"

expect_sql_failure \
  authority_ok \
  'quarantined Bitget depth restoration was accepted' \
  'source has no exact copier snapshot source authority' \
  "SET session_replication_role=replica; UPDATE arena.sources SET copier_table_depth='full' WHERE slug='bitget_futures'"

expect_sql_failure \
  authority_ok \
  'source identity mutation bypassed the registry' \
  'registered copier source identity is immutable' \
  "UPDATE arena.sources SET adapter_slug='foreign' WHERE slug='btcc_futures'"

psql_db authority_ok -q -c \
  "ALTER TABLE arena.copier_snapshot_source_authorities DISABLE TRIGGER copier_snapshot_source_authority_reject_mutation"
expect_sql_failure \
  authority_ok \
  'eligible registry row accepted SQL NULL verifier' \
  'copier_snapshot_source_authority_publication_shape' \
  "UPDATE arena.copier_snapshot_source_authorities SET terminal_verifier_contract=NULL WHERE source_slug='binance_futures'"
expect_sql_failure \
  authority_ok \
  'non-LBank non-publication registry identity was accepted' \
  'copier_snapshot_source_authority_publication_shape' \
  "UPDATE arena.copier_snapshot_source_authorities SET adapter_slug='foreign' WHERE source_slug='lbank_futures'"
expect_sql_failure \
  authority_ok \
  'LBank non-publication row accepted a verifier contract' \
  'copier_snapshot_source_authority_publication_shape' \
  "UPDATE arena.copier_snapshot_source_authorities SET terminal_verifier_contract='arena.ingest.history-terminal-verifier.lbank.copiers@1' WHERE source_slug='lbank_futures'"
psql_db authority_ok -q -c \
  "ALTER TABLE arena.copier_snapshot_source_authorities ENABLE ALWAYS TRIGGER copier_snapshot_source_authority_reject_mutation"

expect_sql_failure \
  authority_ok \
  'authority registry INSERT mutation was accepted' \
  'registry is immutable' \
  "INSERT INTO arena.copier_snapshot_source_authorities SELECT * FROM arena.copier_snapshot_source_authorities LIMIT 1"

expect_sql_failure \
  authority_ok \
  'authority registry UPDATE mutation was accepted' \
  'registry is immutable' \
  "UPDATE arena.copier_snapshot_source_authorities SET contract_version=contract_version"

expect_sql_failure \
  authority_ok \
  'authority registry DELETE mutation was accepted' \
  'registry is immutable' \
  "DELETE FROM arena.copier_snapshot_source_authorities"

expect_sql_failure \
  authority_ok \
  'authority registry TRUNCATE mutation was accepted' \
  'registry is immutable' \
  "SET session_replication_role=replica; TRUNCATE arena.copier_snapshot_source_authorities"

expect_sql_failure \
  authority_ok \
  'service role read private registry' \
  'permission denied' \
  "SET ROLE service_role; SELECT * FROM arena.copier_snapshot_source_authorities"

# Even a deliberately injected historical drift (requiring postgres to disable
# the ALWAYS guard) cannot light the B2C tab without an exact current registry
# tuple. This covers old verifier, wrong depth, and unregistered source shapes.
psql_db authority_ok -q <<'SQL'
ALTER TABLE arena.copier_snapshot_publications
  DISABLE TRIGGER copier_snapshot_publication_00_source_authority;
ALTER TABLE arena.copier_snapshot_publications
  DISABLE TRIGGER copier_snapshot_publication_guard_insert_v1;
INSERT INTO arena.copier_snapshot_publications (
  source_id, trader_id, source_depth, currency, terminal_verifier_contract,
  evidence_contract, publisher_contract, evidence_state,
  scan_terminal_state, caller_limited, blocker_reasons
)
SELECT source_row.id, trader_row.id, 'full', 'USDT',
  'arena.ingest.history-terminal-verifier.bitunix.copiers@2',
  'arena.copier-snapshot-publication@2',
  'arena.ingest.copier-snapshot-publisher@2',
  'verified', 'exhausted', false, '[]'::jsonb
FROM arena.sources AS source_row
JOIN arena.traders AS trader_row ON trader_row.source_id=source_row.id
WHERE source_row.slug='bitunix_futures'
UNION ALL
SELECT source_row.id, trader_row.id, 'top10', 'USDT',
  'arena.ingest.history-terminal-verifier.coinex.copiers@2',
  'arena.copier-snapshot-publication@2',
  'arena.ingest.copier-snapshot-publisher@2',
  'verified', 'exhausted', false, '[]'::jsonb
FROM arena.sources AS source_row
JOIN arena.traders AS trader_row ON trader_row.source_id=source_row.id
WHERE source_row.slug='coinex_futures'
UNION ALL
SELECT source_row.id, trader_row.id, 'top3_preview', 'USDT',
  'arena.ingest.history-terminal-verifier.lbank.copiers@1',
  'arena.copier-snapshot-publication@2',
  'arena.ingest.copier-snapshot-publisher@2',
  'verified', 'exhausted', false, '[]'::jsonb
FROM arena.sources AS source_row
JOIN arena.traders AS trader_row ON trader_row.source_id=source_row.id
WHERE source_row.slug='lbank_futures';
ALTER TABLE arena.copier_snapshot_publications
  ENABLE ALWAYS TRIGGER copier_snapshot_publication_00_source_authority;
ALTER TABLE arena.copier_snapshot_publications
  ENABLE ALWAYS TRIGGER copier_snapshot_publication_guard_insert_v1;
UPDATE arena.sources
SET status='active', serving_mode='serving'
WHERE slug IN ('bitunix_futures','coinex_futures');
SQL

assert_equal \
  'capability accepted old verifier, wrong depth, or unregistered receipt' \
  'bitunix_futures|false
coinex_futures|false
lbank_futures|false' \
  "$(psql_db authority_ok -Atqc "WITH caps AS (SELECT public.arena_source_capabilities() AS payload) SELECT target.slug || '|' || (caps.payload->target.slug->'surfaces'->>'copiers') FROM caps CROSS JOIN (VALUES ('bitunix_futures'),('coinex_futures'),('lbank_futures')) AS target(slug) ORDER BY target.slug")"

assert_equal \
  'reader accepted old verifier, wrong depth, or unregistered receipt' \
  'true|true|true' \
  "$(psql_db authority_ok -Atqc "SET ROLE anon; SELECT (public.arena_copier_aggregate('bitunix_futures','bitunix_futures-trader') IS NULL)::text || '|' || (public.arena_copier_aggregate('coinex_futures','coinex_futures-trader') IS NULL)::text || '|' || (public.arena_copier_aggregate('lbank_futures','lbank_futures-trader') IS NULL)::text")"

# Remove only the deliberately injected drift before proving exact replay.
cleanup_receipts "terminal_verifier_contract IN ('arena.ingest.history-terminal-verifier.bitunix.copiers@2','arena.ingest.history-terminal-verifier.lbank.copiers@1') OR (source_id=(SELECT id FROM arena.sources WHERE slug='coinex_futures') AND source_depth='top10')"
psql_db authority_ok -q -f "$MIGRATION"

assert_equal \
  'copier source authority replay drifted' \
  '14|5|2' \
  "$(psql_db authority_ok -Atqc "SELECT (SELECT count(*) FROM arena.copier_snapshot_source_authorities) || '|' || (SELECT count(*) FROM pg_trigger WHERE tgenabled='A' AND tgname LIKE 'copier_snapshot%authority%') || '|' || (SELECT count(*) FROM arena.copier_snapshot_publications)")"

echo 'copier snapshot source authority 054700 PostgreSQL 17 proof passed'
