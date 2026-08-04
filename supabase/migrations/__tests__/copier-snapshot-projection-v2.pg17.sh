#!/usr/bin/env bash

# Isolated PostgreSQL 17 byte-for-byte replay of the TypeScript copier
# projection golden fixture. The disposable cluster never touches app data.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
GOLDEN="$ROOT_DIR/supabase/migrations/__tests__/fixtures/copier-snapshot-projection-v2-golden.json"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ "$("$PG_BIN/psql" --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo "This integration proof requires PostgreSQL 17" >&2
  exit 1
fi
if [[ ! -s "$GOLDEN" ]]; then
  echo "Copier projection golden fixture is missing: $GOLDEN" >&2
  exit 1
fi

FIXTURE_JSON="$(tr -d '\n' <"$GOLDEN")"
TMP_ROOT="$(mktemp -d /tmp/copier-projection-v2-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((62000 + ($$ % 3000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -220 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -v fixture_json="$FIXTURE_JSON" \
    -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres "$@"
}

"$PG_BIN/initdb" \
  -D "$DATA_DIR" \
  --username=postgres \
  --auth-local=trust \
  --auth-host=trust \
  --encoding=UTF8 \
  --no-locale >/dev/null
"$PG_BIN/pg_ctl" \
  -D "$DATA_DIR" \
  -l "$LOG_FILE" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" \
  -w start >/dev/null

psql_cmd -q <<'SQL'
CREATE TEMP TABLE copier_projection_golden (
  payload jsonb NOT NULL
);
INSERT INTO copier_projection_golden (payload)
VALUES (:'fixture_json'::jsonb);

CREATE FUNCTION pg_temp.encode_nullable_utf8(p_value text)
RETURNS bytea
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT CASE
    WHEN p_value IS NULL THEN pg_catalog.decode('00', 'hex')
    ELSE pg_catalog.decode('01', 'hex')
      || pg_catalog.int4send(pg_catalog.octet_length(p_value))
      || pg_catalog.convert_to(p_value, 'UTF8')
  END
$function$;

CREATE FUNCTION pg_temp.encode_multiset_header(p_contract text, p_count bigint)
RETURNS bytea
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT CASE
    WHEN p_count < 0 THEN NULL
    ELSE pg_temp.encode_nullable_utf8(p_contract) || pg_catalog.int8send(p_count)
  END
$function$;

DO $proof$
DECLARE
  fixture jsonb;
  vector jsonb;
  tuple_value jsonb;
  encoded_bytes bytea;
  member_bytes bytea;
  expected_hex text;
  expected_sha256 text;
  actual_utf8_hex text;
  candidate_empty_sha256 text;
  pair_empty_sha256 text;
BEGIN
  SELECT golden.payload INTO STRICT fixture
  FROM copier_projection_golden AS golden;

  IF pg_catalog.current_setting('server_encoding') IS DISTINCT FROM 'UTF8' THEN
    RAISE EXCEPTION 'copier projection proof requires UTF8 server encoding';
  END IF;

  IF fixture->>'contract' IS DISTINCT FROM 'arena.ingest.copier-projection-v2-golden@2'
     OR fixture->>'projection_tuple_contract'
          IS DISTINCT FROM 'arena.ingest.copier-projection-tuple@1'
     OR fixture->>'length_prefixed_utf8_contract'
          IS DISTINCT FROM 'arena.ingest.length-prefixed-utf8.nonnegative-int32be@1'
     OR fixture->>'source_candidate_fixed_multiset_contract'
          IS DISTINCT FROM 'arena.ingest.copier-source-candidate-sha256-multiset.domain-count-fixed-bytes@1'
     OR fixture->>'candidate_projection_fixed_multiset_contract'
          IS DISTINCT FROM 'arena.ingest.copier-candidate-projection-sha256-multiset.domain-count-fixed-bytes@1'
     OR fixture->>'hash_algorithm' IS DISTINCT FROM 'sha256'
     OR fixture->'tuple_field_order' IS DISTINCT FROM
          '["contract","source_candidate_sha256","source_event_at","copier_label","copier_pnl","copier_invested","copy_duration_days","dedupe_hash"]'::jsonb
     OR fixture->'encoding_spec' IS DISTINCT FROM
          '{"null_token_hex":"00","nonnull_marker_hex":"01","length_bytes":4,"length_byte_order":"big_endian","length_scope":"utf8_value_bytes","postgres_length_primitive":"pg_catalog.int4send(pg_catalog.octet_length(value))"}'::jsonb
     OR fixture->'multiset_encoding_spec' IS DISTINCT FROM
          '{"domain_token_contract":"arena.ingest.length-prefixed-utf8.nonnegative-int32be@1","count_bytes":8,"count_byte_order":"big_endian","count_range":"nonnegative_postgresql_bigint","postgres_count_primitive":"pg_catalog.int8send(count)","member_sort":"decoded_bytea_ascending","duplicates":"preserve_occurrences"}'::jsonb
  THEN
    RAISE EXCEPTION 'copier projection golden root contract drifted';
  END IF;

  FOR vector IN
    SELECT item.value
    FROM pg_catalog.jsonb_array_elements(fixture->'encoding_vectors') AS item(value)
  LOOP
    encoded_bytes := pg_temp.encode_nullable_utf8(vector->>'value');
    IF pg_catalog.encode(encoded_bytes, 'hex') IS DISTINCT FROM vector->>'token_hex' THEN
      RAISE EXCEPTION 'nullable UTF-8 token mismatch for %', vector->>'name';
    END IF;

    actual_utf8_hex := CASE
      WHEN vector->'value' = 'null'::jsonb THEN NULL
      ELSE pg_catalog.encode(pg_catalog.convert_to(vector->>'value', 'UTF8'), 'hex')
    END;
    IF actual_utf8_hex IS DISTINCT FROM vector->>'utf8_hex' THEN
      RAISE EXCEPTION 'UTF-8 scalar mismatch for %', vector->>'name';
    END IF;
  END LOOP;

  FOR vector IN
    SELECT item.value
    FROM pg_catalog.jsonb_array_elements(fixture->'decimal_vectors') AS item(value)
  LOOP
    IF pg_catalog.trim_scale((vector->>'input_js_number_text')::numeric)::text
         IS DISTINCT FROM vector->>'canonical_decimal'
    THEN
      RAISE EXCEPTION 'canonical decimal mismatch for %', vector->>'input_js_number_text';
    END IF;
  END LOOP;

  FOR vector IN
    SELECT item.value
    FROM pg_catalog.jsonb_array_elements(fixture->'projection_vectors') AS item(value)
  LOOP
    tuple_value := vector->'tuple';
    encoded_bytes :=
      pg_temp.encode_nullable_utf8(tuple_value->>'contract')
      || pg_temp.encode_nullable_utf8(tuple_value->>'source_candidate_sha256')
      || pg_temp.encode_nullable_utf8(tuple_value->>'source_event_at')
      || pg_temp.encode_nullable_utf8(tuple_value->>'copier_label')
      || pg_temp.encode_nullable_utf8(tuple_value->>'copier_pnl')
      || pg_temp.encode_nullable_utf8(tuple_value->>'copier_invested')
      || pg_temp.encode_nullable_utf8(tuple_value->>'copy_duration_days')
      || pg_temp.encode_nullable_utf8(tuple_value->>'dedupe_hash');
    IF pg_catalog.jsonb_build_array(
         pg_catalog.encode(pg_temp.encode_nullable_utf8(tuple_value->>'contract'), 'hex'),
         pg_catalog.encode(
           pg_temp.encode_nullable_utf8(tuple_value->>'source_candidate_sha256'), 'hex'
         ),
         pg_catalog.encode(pg_temp.encode_nullable_utf8(tuple_value->>'source_event_at'), 'hex'),
         pg_catalog.encode(pg_temp.encode_nullable_utf8(tuple_value->>'copier_label'), 'hex'),
         pg_catalog.encode(pg_temp.encode_nullable_utf8(tuple_value->>'copier_pnl'), 'hex'),
         pg_catalog.encode(pg_temp.encode_nullable_utf8(tuple_value->>'copier_invested'), 'hex'),
         pg_catalog.encode(
           pg_temp.encode_nullable_utf8(tuple_value->>'copy_duration_days'), 'hex'
         ),
         pg_catalog.encode(pg_temp.encode_nullable_utf8(tuple_value->>'dedupe_hash'), 'hex')
       ) IS DISTINCT FROM vector->'tuple_tokens_hex'
    THEN
      RAISE EXCEPTION 'projection tuple token mismatch for %', vector->>'name';
    END IF;
    expected_hex := vector->>'tuple_hex';
    expected_sha256 := vector->>'projection_sha256';

    IF pg_catalog.encode(encoded_bytes, 'hex') IS DISTINCT FROM expected_hex THEN
      RAISE EXCEPTION 'projection tuple bytes mismatch for %', vector->>'name';
    END IF;
    IF pg_catalog.encode(pg_catalog.sha256(encoded_bytes), 'hex')
         IS DISTINCT FROM expected_sha256
    THEN
      RAISE EXCEPTION 'projection tuple SHA-256 mismatch for %', vector->>'name';
    END IF;
  END LOOP;

  FOR vector IN
    SELECT item.value
    FROM pg_catalog.jsonb_array_elements(fixture->'candidate_multisets') AS item(value)
  LOOP
    encoded_bytes := pg_temp.encode_multiset_header(
      fixture->>'source_candidate_fixed_multiset_contract',
      pg_catalog.jsonb_array_length(vector->'members')::bigint
    );
    FOR member_bytes IN
      SELECT pg_catalog.decode(member.value #>> '{}', 'hex') AS decoded
      FROM pg_catalog.jsonb_array_elements(vector->'members') AS member(value)
      ORDER BY decoded
    LOOP
      IF pg_catalog.octet_length(member_bytes) <> 32 THEN
        RAISE EXCEPTION 'candidate multiset member is not 32 bytes';
      END IF;
      encoded_bytes := encoded_bytes || member_bytes;
    END LOOP;

    IF pg_catalog.encode(encoded_bytes, 'hex') IS DISTINCT FROM vector->>'encoded_hex' THEN
      RAISE EXCEPTION 'candidate fixed multiset bytes mismatch for %', vector->>'name';
    END IF;
    expected_sha256 := vector->>'sha256';
    IF pg_catalog.encode(pg_catalog.sha256(encoded_bytes), 'hex')
         IS DISTINCT FROM expected_sha256
    THEN
      RAISE EXCEPTION 'candidate fixed multiset SHA-256 mismatch for %', vector->>'name';
    END IF;
    IF vector->>'name' = 'empty' THEN
      candidate_empty_sha256 := expected_sha256;
    END IF;
  END LOOP;

  FOR vector IN
    SELECT item.value
    FROM pg_catalog.jsonb_array_elements(fixture->'pair_multisets') AS item(value)
  LOOP
    encoded_bytes := pg_temp.encode_multiset_header(
      fixture->>'candidate_projection_fixed_multiset_contract',
      pg_catalog.jsonb_array_length(vector->'members')::bigint
    );
    FOR member_bytes IN
      SELECT pg_catalog.decode(member.value->>'source_candidate_sha256', 'hex')
             || pg_catalog.decode(member.value->>'projection_sha256', 'hex') AS decoded_pair
      FROM pg_catalog.jsonb_array_elements(vector->'members') AS member(value)
      ORDER BY decoded_pair
    LOOP
      IF pg_catalog.octet_length(member_bytes) <> 64 THEN
        RAISE EXCEPTION 'candidate-projection multiset member is not 64 bytes';
      END IF;
      encoded_bytes := encoded_bytes || member_bytes;
    END LOOP;

    IF pg_catalog.encode(encoded_bytes, 'hex') IS DISTINCT FROM vector->>'encoded_hex' THEN
      RAISE EXCEPTION 'candidate-projection fixed multiset bytes mismatch for %', vector->>'name';
    END IF;
    expected_sha256 := vector->>'sha256';
    IF pg_catalog.encode(pg_catalog.sha256(encoded_bytes), 'hex')
         IS DISTINCT FROM expected_sha256
    THEN
      RAISE EXCEPTION 'candidate-projection fixed multiset SHA-256 mismatch for %', vector->>'name';
    END IF;
    IF vector->>'name' = 'empty' THEN
      pair_empty_sha256 := expected_sha256;
    END IF;
  END LOOP;

  IF candidate_empty_sha256 IS NULL
     OR pair_empty_sha256 IS NULL
     OR candidate_empty_sha256 = pair_empty_sha256
  THEN
    RAISE EXCEPTION 'empty multiset domains are missing or not separated';
  END IF;
END
$proof$;
SQL

echo "copier snapshot projection PostgreSQL 17 golden replay passed"
