import { ingestClientConnect } from '@/lib/ingest/db'

export const PARTITIONED_V4_WORKER_READINESS_CONTRACT =
  'arena.partitioned-leaderboard-worker-readiness@2' as const
export const PARTITIONED_V4_CAPTURE_CONTRACT =
  'arena.ingest.leaderboard-acquisition-manifest@4' as const
export const PARTITIONED_V4_ATTEMPT_BINDING_CONTRACT =
  'arena.ingest.leaderboard-acquisition-attempt-binding@1' as const
export const TIER_A_EXECUTION_CLAIM_ENFORCEMENT_CONTRACT =
  'arena.ingest.tier-a-execution-claim-enforcement@1' as const
export const PARTITIONED_V4_START_RPC_SHA256 =
  '3fe0c7fb170dfd43022f07736012f84cd5083a8e79e038e037efae2b6462cdcd' as const
export const PARTITIONED_V4_FINISH_RPC_SHA256 =
  '3b40b3f8c79a7187edfe42e9f419e79a4d445625d6e6a9c13926470897eb35cb' as const
export const PARTITIONED_V4_CLAIMED_START_RPC_SHA256 =
  '4ce81fb2fd1669ad83cfb04d1b58a719014360194fbea45f6483c383c5aafaa1' as const
export const PARTITIONED_V4_CLAIMED_FINISH_RPC_SHA256 =
  'b9b7d40563d4e06c756aa5d6ff2807f2a23df58331eb1f4fa784b083644b019d' as const
export const TIER_A_EXECUTION_CLAIM_RPC_SHA256 =
  'e42d1a7681eeeede50b27d71925e3ee7dff4aa9bffb016e0fd7d88d70d5d5b53' as const
export const TIER_A_EXECUTION_HEARTBEAT_RPC_SHA256 =
  '8b9068582f1e55fde165657562ed3a3824197866edbe495a295427ab8f4c9528' as const
export const TIER_A_EXECUTION_ASSERT_RPC_SHA256 =
  '09dabe40f76d4508e595c6333889a31a1310109ceebcf45522aaaf8309f8e05d' as const
export const TIER_A_EXECUTION_CLOSE_RPC_SHA256 =
  'd8987ca8991ae35e0c7885b228cd711aeff72a9fade582621eb81cb1d388007e' as const
export const TIER_A_EXECUTION_RECORD_RECEIPT_RPC_SHA256 =
  'e5bb12bf86a5ac29154c8e6e38d1225d9cb356231d358b464e73bdf1463ba887' as const
export const TIER_A_EXECUTION_GET_RECEIPT_RPC_SHA256 =
  '079f55e3f71298e1509659fda8529c6d1f61f05e3aeaaf39c10418a9e082a4c8' as const
export const TIER_A_EXECUTION_ENFORCEMENT_MARKER_RPC_SHA256 =
  '2fdc85842b2bc68331217a820de324ae274395778ab87fb072c787df251db8a4' as const
export const TIER_A_EXECUTION_CONSTRAINT_CATALOG_SHA256 =
  '6e9627e5c475035c5e4f17c39754b25f81b16360ab84244b66bb50239d8dc0a9' as const
export const TIER_A_EXECUTION_TRIGGER_CATALOG_SHA256 =
  '5e77d9f748cdb3993d03724d3f832edbb1087d5fb618d72b62d3fb02f2c12af8' as const

const LEGACY_START_RPC_SIGNATURE =
  'arena.start_leaderboard_acquisition_attempt(uuid,integer,integer,text,text,integer,text,text,text)'
const LEGACY_FINISH_RPC_SIGNATURE =
  'arena.finish_leaderboard_acquisition_attempt(uuid,text,text,text,text,text,timestamp with time zone,timestamp with time zone,text,bigint,bigint,bigint,integer,text,integer,integer,text,integer,integer,integer,integer,boolean,boolean,text,text)'
const CLAIMED_START_RPC_SIGNATURE =
  'arena.start_leaderboard_acquisition_attempt(uuid,integer,integer,text,text,integer,text,text,text,uuid,bigint)'
const CLAIMED_FINISH_RPC_SIGNATURE =
  'arena.finish_leaderboard_acquisition_attempt(uuid,text,text,text,text,text,timestamp with time zone,timestamp with time zone,text,bigint,bigint,bigint,integer,text,integer,integer,text,integer,integer,integer,integer,boolean,boolean,text,text,uuid,bigint)'
const EXECUTION_CLAIM_RPC_SIGNATURE =
  'arena.claim_tier_a_execution(uuid,integer,text,text,text,integer,integer,text,uuid,text,text,integer)'
const EXECUTION_HEARTBEAT_RPC_SIGNATURE = 'arena.heartbeat_tier_a_execution(uuid,bigint)'
const EXECUTION_ASSERT_RPC_SIGNATURE = 'arena.assert_tier_a_execution_write(uuid,bigint)'
const EXECUTION_CLOSE_RPC_SIGNATURE = 'arena.close_tier_a_execution(uuid,bigint,text)'
const EXECUTION_RECORD_RECEIPT_RPC_SIGNATURE =
  'arena.record_tier_a_execution_window_receipt(uuid,bigint,uuid,bigint)'
const EXECUTION_GET_RECEIPT_RPC_SIGNATURE =
  'arena.get_tier_a_execution_window_receipt(integer,text,text,text,integer)'
const EXECUTION_ENFORCEMENT_MARKER_RPC_SIGNATURE =
  'arena.tier_a_execution_claim_enforcement_state()'

const REGISTRY_ROW_KEYS = [
  'adapter_slug',
  'attempt_binding_contract',
  'boards',
  'cadence_contract_exact',
  'capture_contract',
  'currency',
  'exchange_slug',
  'page_size',
  'pagination_kind',
  'product_type',
  'requires_runner_git_sha',
  'serving_mode',
  'source_adapter_slug',
  'source_slug',
  'status',
  'timeframes_derived',
  'timeframes_native',
  'trader_kind_scope',
] as const
const RPC_ROW_KEYS = [
  'claimed_finish_rpc_sha256',
  'claimed_runtime_acl_exact',
  'claimed_runtime_contract_exact',
  'claimed_start_rpc_sha256',
  'execution_assert_rpc_sha256',
  'execution_claim_rpc_sha256',
  'execution_close_rpc_sha256',
  'execution_get_receipt_rpc_sha256',
  'execution_heartbeat_rpc_sha256',
  'execution_record_receipt_rpc_sha256',
  'legacy_contract_exact',
  'legacy_enforced_acl_exact',
  'legacy_expand_acl_exact',
  'legacy_finish_rpc_sha256',
  'legacy_start_rpc_sha256',
] as const
const ENFORCEMENT_ROW_KEYS = [
  'marker_acl_exact',
  'marker_contract_exact',
  'marker_payload',
  'marker_present',
  'marker_rpc_sha256',
  'state',
  'substrate_contract_exact',
] as const
const ENFORCEMENT_MARKER_PAYLOAD_KEYS = ['contract', 'state'] as const
const EXPECTED_SOURCE_SLUGS = ['bitget_bots_futures', 'bitget_bots_spot'] as const

const REGISTRY_SQL = `WITH candidate_sources AS (
    SELECT capture.source_id
    FROM arena.leaderboard_capture_contracts AS capture
    WHERE capture.capture_contract =
          'arena.ingest.leaderboard-acquisition-manifest@4'
    UNION
    SELECT source_row.id AS source_id
    FROM arena.sources AS source_row
    WHERE source_row.status = 'active'
      AND source_row.adapter_slug = 'bitget_bots'
  )
  SELECT
    source_row.slug AS source_slug,
    exchange_row.slug AS exchange_slug,
    source_row.adapter_slug AS source_adapter_slug,
    source_row.product_type,
    source_row.trader_kind_scope,
    source_row.status,
    source_row.serving_mode,
    source_row.currency,
    source_row.timeframes_native,
    source_row.timeframes_derived,
    source_row.page_size,
    source_row.pagination_kind,
    source_row.meta->'boards' AS boards,
    (
      source_row.cadence_tier_a > interval '0 seconds'
      AND source_row.cadence_tier_a <= interval '7 days'
    ) AS cadence_contract_exact,
    capture.capture_contract,
    capture.adapter_slug,
    capture.attempt_binding_contract,
    capture.requires_runner_git_sha
  FROM candidate_sources AS candidate
  JOIN arena.sources AS source_row
    ON source_row.id = candidate.source_id
  JOIN arena.exchanges AS exchange_row
    ON exchange_row.id = source_row.exchange_id
  LEFT JOIN arena.leaderboard_capture_contracts AS capture
    ON capture.source_id = source_row.id
   AND capture.capture_contract =
       'arena.ingest.leaderboard-acquisition-manifest@4'
  ORDER BY source_row.slug ASC`

const LEGACY_RPC_CONFIG = `ARRAY[
      'search_path=pg_catalog, pg_temp',
      'lock_timeout=5s',
      'statement_timeout=30s'
    ]::pg_catalog.text[]`
const CLAIMED_RPC_CONFIG = `ARRAY[
      'search_path=pg_catalog, pg_temp',
      'TimeZone=UTC',
      'lock_timeout=10s',
      'statement_timeout=30s'
    ]::pg_catalog.text[]`
const RECEIPT_LOOKUP_RPC_CONFIG = `ARRAY[
      'search_path=pg_catalog, pg_temp',
      'TimeZone=UTC',
      'statement_timeout=30s'
    ]::pg_catalog.text[]`

const RPC_SQL = `WITH expected(
    rpc_name,
    rollout_group,
    signature,
    expected_sha256,
    expected_volatility,
    expected_return_type,
    expected_config
  ) AS (
    VALUES
      (
        'legacy_start',
        'legacy',
        '${LEGACY_START_RPC_SIGNATURE}',
        '${PARTITIONED_V4_START_RPC_SHA256}',
        'v',
        'arena.leaderboard_acquisition_attempts',
        ${LEGACY_RPC_CONFIG}
      ),
      (
        'legacy_finish',
        'legacy',
        '${LEGACY_FINISH_RPC_SIGNATURE}',
        '${PARTITIONED_V4_FINISH_RPC_SHA256}',
        'v',
        'arena.leaderboard_acquisition_outcomes',
        ${LEGACY_RPC_CONFIG}
      ),
      (
        'claimed_start',
        'claimed',
        '${CLAIMED_START_RPC_SIGNATURE}',
        '${PARTITIONED_V4_CLAIMED_START_RPC_SHA256}',
        'v',
        'arena.leaderboard_acquisition_attempts',
        ${CLAIMED_RPC_CONFIG}
      ),
      (
        'claimed_finish',
        'claimed',
        '${CLAIMED_FINISH_RPC_SIGNATURE}',
        '${PARTITIONED_V4_CLAIMED_FINISH_RPC_SHA256}',
        'v',
        'arena.leaderboard_acquisition_outcomes',
        ${CLAIMED_RPC_CONFIG}
      ),
      (
        'execution_claim',
        'claimed',
        '${EXECUTION_CLAIM_RPC_SIGNATURE}',
        '${TIER_A_EXECUTION_CLAIM_RPC_SHA256}',
        'v',
        'jsonb',
        ${CLAIMED_RPC_CONFIG}
      ),
      (
        'execution_heartbeat',
        'claimed',
        '${EXECUTION_HEARTBEAT_RPC_SIGNATURE}',
        '${TIER_A_EXECUTION_HEARTBEAT_RPC_SHA256}',
        'v',
        'jsonb',
        ${CLAIMED_RPC_CONFIG}
      ),
      (
        'execution_assert',
        'claimed',
        '${EXECUTION_ASSERT_RPC_SIGNATURE}',
        '${TIER_A_EXECUTION_ASSERT_RPC_SHA256}',
        'v',
        'jsonb',
        ${CLAIMED_RPC_CONFIG}
      ),
      (
        'execution_close',
        'claimed',
        '${EXECUTION_CLOSE_RPC_SIGNATURE}',
        '${TIER_A_EXECUTION_CLOSE_RPC_SHA256}',
        'v',
        'jsonb',
        ${CLAIMED_RPC_CONFIG}
      ),
      (
        'execution_record_receipt',
        'claimed',
        '${EXECUTION_RECORD_RECEIPT_RPC_SIGNATURE}',
        '${TIER_A_EXECUTION_RECORD_RECEIPT_RPC_SHA256}',
        'v',
        'jsonb',
        ${CLAIMED_RPC_CONFIG}
      ),
      (
        'execution_get_receipt',
        'claimed',
        '${EXECUTION_GET_RECEIPT_RPC_SIGNATURE}',
        '${TIER_A_EXECUTION_GET_RECEIPT_RPC_SHA256}',
        's',
        'jsonb',
        ${RECEIPT_LOOKUP_RPC_CONFIG}
      )
  ),
  proof AS (
    SELECT
      expected.rpc_name,
      expected.rollout_group,
      CASE
        WHEN function_row.oid IS NULL THEN NULL
        ELSE pg_catalog.encode(
          pg_catalog.sha256(pg_catalog.convert_to(function_row.prosrc, 'UTF8')),
          'hex'
        )
      END AS rpc_sha256,
      (
        function_row.oid IS NOT NULL
        AND function_row.prokind = 'f'
        AND function_row.proowner = 'postgres'::pg_catalog.regrole
        AND function_row.prosecdef
        AND function_row.provolatile = expected.expected_volatility::"char"
        AND NOT function_row.proretset
        AND NOT function_row.proisstrict
        AND NOT function_row.proleakproof
        AND function_row.proparallel = 'u'
        AND function_row.proargmodes IS NULL
        AND language_row.lanname = 'plpgsql'
        AND function_row.prorettype =
            pg_catalog.to_regtype(expected.expected_return_type)
        AND pg_catalog.encode(
          pg_catalog.sha256(pg_catalog.convert_to(function_row.prosrc, 'UTF8')),
          'hex'
        ) = expected.expected_sha256
        AND function_row.proconfig @> expected.expected_config
        AND pg_catalog.cardinality(function_row.proconfig) =
            pg_catalog.cardinality(expected.expected_config)
      ) AS contract_exact,
      (
        function_row.oid IS NOT NULL
        AND pg_catalog.has_function_privilege(
          'service_role', function_row.oid, 'EXECUTE'
        )
        AND NOT pg_catalog.has_function_privilege(
          'anon', function_row.oid, 'EXECUTE'
        )
        AND NOT pg_catalog.has_function_privilege(
          'authenticated', function_row.oid, 'EXECUTE'
        )
        AND EXISTS (
          SELECT 1
          FROM pg_catalog.aclexplode(
            COALESCE(
              function_row.proacl,
              pg_catalog.acldefault('f', function_row.proowner)
            )
          ) AS acl_row
          WHERE acl_row.privilege_type = 'EXECUTE'
            AND acl_row.grantee = 'service_role'::pg_catalog.regrole
            AND NOT acl_row.is_grantable
        )
        AND NOT EXISTS (
          SELECT 1
          FROM pg_catalog.aclexplode(
            COALESCE(
              function_row.proacl,
              pg_catalog.acldefault('f', function_row.proowner)
            )
          ) AS acl_row
          WHERE acl_row.privilege_type = 'EXECUTE'
            AND acl_row.grantee <> function_row.proowner
            AND (
              acl_row.grantee <> 'service_role'::pg_catalog.regrole
              OR acl_row.is_grantable
            )
        )
      ) AS service_acl_exact,
      (
        function_row.oid IS NOT NULL
        AND NOT pg_catalog.has_function_privilege(
          'service_role', function_row.oid, 'EXECUTE'
        )
        AND NOT pg_catalog.has_function_privilege(
          'anon', function_row.oid, 'EXECUTE'
        )
        AND NOT pg_catalog.has_function_privilege(
          'authenticated', function_row.oid, 'EXECUTE'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM pg_catalog.aclexplode(
            COALESCE(
              function_row.proacl,
              pg_catalog.acldefault('f', function_row.proowner)
            )
          ) AS acl_row
          WHERE acl_row.privilege_type = 'EXECUTE'
            AND acl_row.grantee <> function_row.proowner
        )
      ) AS owner_acl_exact
    FROM expected
    LEFT JOIN pg_catalog.pg_proc AS function_row
      ON function_row.oid = pg_catalog.to_regprocedure(expected.signature)
    LEFT JOIN pg_catalog.pg_language AS language_row
      ON language_row.oid = function_row.prolang
  )
  SELECT
    pg_catalog.max(rpc_sha256) FILTER (
      WHERE rpc_name = 'legacy_start'
    ) AS legacy_start_rpc_sha256,
    pg_catalog.max(rpc_sha256) FILTER (
      WHERE rpc_name = 'legacy_finish'
    ) AS legacy_finish_rpc_sha256,
    pg_catalog.max(rpc_sha256) FILTER (
      WHERE rpc_name = 'claimed_start'
    ) AS claimed_start_rpc_sha256,
    pg_catalog.max(rpc_sha256) FILTER (
      WHERE rpc_name = 'claimed_finish'
    ) AS claimed_finish_rpc_sha256,
    pg_catalog.max(rpc_sha256) FILTER (
      WHERE rpc_name = 'execution_claim'
    ) AS execution_claim_rpc_sha256,
    pg_catalog.max(rpc_sha256) FILTER (
      WHERE rpc_name = 'execution_heartbeat'
    ) AS execution_heartbeat_rpc_sha256,
    pg_catalog.max(rpc_sha256) FILTER (
      WHERE rpc_name = 'execution_assert'
    ) AS execution_assert_rpc_sha256,
    pg_catalog.max(rpc_sha256) FILTER (
      WHERE rpc_name = 'execution_close'
    ) AS execution_close_rpc_sha256,
    pg_catalog.max(rpc_sha256) FILTER (
      WHERE rpc_name = 'execution_record_receipt'
    ) AS execution_record_receipt_rpc_sha256,
    pg_catalog.max(rpc_sha256) FILTER (
      WHERE rpc_name = 'execution_get_receipt'
    ) AS execution_get_receipt_rpc_sha256,
    COALESCE(
      pg_catalog.bool_and(contract_exact) FILTER (
        WHERE rollout_group = 'legacy'
      ),
      false
    ) AS legacy_contract_exact,
    COALESCE(
      pg_catalog.bool_and(contract_exact) FILTER (
        WHERE rollout_group = 'claimed'
      ),
      false
    ) AS claimed_runtime_contract_exact,
    COALESCE(
      pg_catalog.bool_and(service_acl_exact) FILTER (
        WHERE rollout_group = 'claimed'
      ),
      false
    ) AS claimed_runtime_acl_exact,
    COALESCE(
      pg_catalog.bool_and(service_acl_exact) FILTER (
        WHERE rollout_group = 'legacy'
      ),
      false
    ) AS legacy_expand_acl_exact,
    COALESCE(
      pg_catalog.bool_and(owner_acl_exact) FILTER (
        WHERE rollout_group = 'legacy'
      ),
      false
    ) AS legacy_enforced_acl_exact
  FROM proof`

export const TIER_A_EXECUTION_ENFORCEMENT_CATALOG_SQL = `WITH marker_identity AS (
    SELECT pg_catalog.to_regprocedure(
      '${EXECUTION_ENFORCEMENT_MARKER_RPC_SIGNATURE}'
    ) AS marker_oid
  ),
  expected_columns(
    table_oid,
    column_name,
    type_oid,
    is_not_null,
    default_expression
  ) AS (
    VALUES
      ('arena.sources'::pg_catalog.regclass, 'id'::name, 'smallint'::pg_catalog.regtype, true, NULL::text),
      ('arena.sources'::pg_catalog.regclass, 'status'::name, 'text'::pg_catalog.regtype, true, NULL::text),
      ('arena.sources'::pg_catalog.regclass, 'fetch_region'::name, 'text'::pg_catalog.regtype, true, NULL::text),
      ('arena.leaderboard_snapshots'::pg_catalog.regclass, 'source_id'::name, 'smallint'::pg_catalog.regtype, true, NULL::text),
      ('arena.leaderboard_snapshots'::pg_catalog.regclass, 'is_derived'::name, 'boolean'::pg_catalog.regtype, true, NULL::text),
      ('arena.raw_objects'::pg_catalog.regclass, 'source_id'::name, 'smallint'::pg_catalog.regtype, true, NULL::text),
      ('arena.raw_objects'::pg_catalog.regclass, 'job_type'::name, 'text'::pg_catalog.regtype, true, NULL::text),
      ('arena.upstream_field_inventory'::pg_catalog.regclass, 'source_id'::name, 'smallint'::pg_catalog.regtype, true, NULL::text),
      ('arena.upstream_field_inventory'::pg_catalog.regclass, 'job_type'::name, 'text'::pg_catalog.regtype, true, NULL::text),
      ('arena.leaderboard_acquisition_attempts'::pg_catalog.regclass, 'attempt_seq'::name, 'bigint'::pg_catalog.regtype, true, NULL::text),
      ('arena.leaderboard_acquisition_attempts'::pg_catalog.regclass, 'source_id'::name, 'smallint'::pg_catalog.regtype, true, NULL::text),
      ('arena.leaderboard_acquisition_attempts'::pg_catalog.regclass, 'source_slug'::name, 'text'::pg_catalog.regtype, true, NULL::text),
      ('arena.leaderboard_acquisition_attempts'::pg_catalog.regclass, 'queue_job_id'::name, 'text'::pg_catalog.regtype, false, NULL::text),
      ('arena.leaderboard_acquisition_attempts'::pg_catalog.regclass, 'queue_attempt'::name, 'integer'::pg_catalog.regtype, true, NULL::text),
      ('arena.leaderboard_acquisition_attempts'::pg_catalog.regclass, 'worker_region'::name, 'text'::pg_catalog.regtype, false, NULL::text),
      ('arena.leaderboard_acquisition_attempts'::pg_catalog.regclass, 'source_fetch_region'::name, 'text'::pg_catalog.regtype, true, NULL::text),
      ('arena.leaderboard_acquisition_attempts'::pg_catalog.regclass, 'execution_claim_id'::name, 'uuid'::pg_catalog.regtype, false, NULL::text),
      ('arena.leaderboard_acquisition_attempts'::pg_catalog.regclass, 'execution_generation_seq'::name, 'bigint'::pg_catalog.regtype, false, NULL::text),
      ('arena.leaderboard_acquisition_outcomes'::pg_catalog.regclass, 'attempt_seq'::name, 'bigint'::pg_catalog.regtype, true, NULL::text),
      ('arena.tier_a_execution_claims'::pg_catalog.regclass, 'source_id'::name, 'smallint'::pg_catalog.regtype, true, NULL::text),
      ('arena.tier_a_execution_claims'::pg_catalog.regclass, 'generation_seq'::name, 'bigint'::pg_catalog.regtype, true, NULL::text),
      ('arena.tier_a_execution_claims'::pg_catalog.regclass, 'claim_id'::name, 'uuid'::pg_catalog.regtype, true, NULL::text),
      ('arena.tier_a_execution_claims'::pg_catalog.regclass, 'queue_job_id'::name, 'text'::pg_catalog.regtype, true, NULL::text),
      ('arena.tier_a_execution_claims'::pg_catalog.regclass, 'queue_attempt'::name, 'integer'::pg_catalog.regtype, true, NULL::text),
      ('arena.tier_a_execution_claims'::pg_catalog.regclass, 'execution_region'::name, 'text'::pg_catalog.regtype, true, NULL::text),
      ('arena.tier_a_execution_claims'::pg_catalog.regclass, 'source_lease_scope_id'::name, 'text'::pg_catalog.regtype, true, NULL::text),
      ('arena.tier_a_execution_write_guards'::pg_catalog.regclass, 'top_xid8_text'::name, 'text'::pg_catalog.regtype, true, NULL::text),
      ('arena.tier_a_execution_write_guards'::pg_catalog.regclass, 'source_id'::name, 'smallint'::pg_catalog.regtype, true, NULL::text),
      ('arena.tier_a_execution_write_guards'::pg_catalog.regclass, 'generation_seq'::name, 'bigint'::pg_catalog.regtype, true, NULL::text),
      ('arena.tier_a_execution_write_guards'::pg_catalog.regclass, 'claim_id'::name, 'uuid'::pg_catalog.regtype, true, NULL::text),
      ('arena.tier_a_execution_write_guards'::pg_catalog.regclass, 'verification_round'::name, 'smallint'::pg_catalog.regtype, true, '0'),
      ('arena.tier_a_execution_write_guards'::pg_catalog.regclass, 'worker_region'::name, 'text'::pg_catalog.regtype, true, NULL::text)
  ),
  column_contract AS (
    SELECT
      pg_catalog.count(attribute.attrelid) = 32
      AND pg_catalog.bool_and(
        attribute.attrelid IS NOT NULL
        AND attribute.atttypid = expected.type_oid
        AND attribute.attnotnull = expected.is_not_null
        AND (
          expected.default_expression IS NULL
          OR (
            attribute.attidentity = ''
            AND attribute.attgenerated = ''
            AND pg_catalog.pg_get_expr(
                  default_row.adbin,
                  default_row.adrelid,
                  true
                ) = expected.default_expression
          )
        )
      ) AS exact
    FROM expected_columns AS expected
    LEFT JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = expected.table_oid
     AND attribute.attname = expected.column_name
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped
    LEFT JOIN pg_catalog.pg_attrdef AS default_row
      ON default_row.adrelid = attribute.attrelid
     AND default_row.adnum = attribute.attnum
  ),
  expected_functions(
    signature,
    source_sha256,
    security_definer,
    volatility,
    language_name,
    return_type,
    config
  ) AS (
    VALUES
      (
        'arena.reject_direct_leaderboard_acquisition_mutation()'::text,
        '79757dc5b663d38bf00aa5f19675d765eb6d6863a2cfc9fb99e797854fb234b0'::text,
        false,
        'v'::text,
        'plpgsql'::text,
        'trigger'::text,
        ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
      ),
      (
        'arena.protect_metric_trust_raw_object()',
        'ae03cfdeb594edba511c6bffbb425e971c273626c0571c7522e2f942c242c8a0',
        false,
        'v',
        'plpgsql',
        'trigger',
        ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
      ),
      (
        'arena.protect_leaderboard_acquisition_raw_evidence()',
        '3967f6e165ffeecb8c15b1df38802c74edd201f9bd4aac6fcddee8a6fa6384e2',
        false,
        'v',
        'plpgsql',
        'trigger',
        ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
      ),
      (
        'arena.serialize_leaderboard_terminal_publication()',
        '3059e24b558fea0d12872eeb9892325e029e1112ca2729cbc728a8edb426430a',
        true,
        'v',
        'plpgsql',
        'trigger',
        ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
      ),
      (
        'arena.reject_tier_a_execution_immutable_mutation()',
        '04828313d06a9f21b8a5c68fd0715b2116003aa8ce05d3c2159f81cc82c20f51',
        true,
        'v',
        'plpgsql',
        'trigger',
        ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
      ),
      (
        'arena.require_current_tier_a_worker_guard(integer)',
        '1ff3691191ca63e70bfed4bf13f4dc97a7a515db5f732e9ddb181ae4b65d40f2',
        true,
        'v',
        'plpgsql',
        'arena.ingest_worker_write_guards',
        ARRAY[
          'search_path=pg_catalog, pg_temp',
          'TimeZone=UTC',
          'lock_timeout=5s',
          'statement_timeout=30s'
        ]::pg_catalog.text[]
      ),
      (
        'arena.require_current_tier_a_execution_guard(integer)',
        '0d551e74da91c88f245eb09002b2a16b3f11f2c7009302a866f0dc7e71c9208a',
        true,
        'v',
        'plpgsql',
        'arena.tier_a_execution_write_guards',
        ARRAY[
          'search_path=pg_catalog, pg_temp',
          'TimeZone=UTC',
          'statement_timeout=30s'
        ]::pg_catalog.text[]
      ),
      (
        'arena.require_tier_a_snapshot_execution_guard()',
        'e12f729b62503b1dd236e580d50069e9224575229fbfe6adb5040715689fecc9',
        true,
        'v',
        'plpgsql',
        'trigger',
        ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
      ),
      (
        'arena.require_tier_a_raw_execution_guard()',
        '16d5e537b4cb086657f0641f72ed5f569564870756fa22063c5bb6f3a8e44be7',
        true,
        'v',
        'plpgsql',
        'trigger',
        ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
      ),
      (
        'arena.require_tier_a_field_inventory_execution_guard()',
        '60cf710a84926fdc7e84cb2321cb357a97a95ae83025a54f5c1f90f74fcf5033',
        true,
        'v',
        'plpgsql',
        'trigger',
        ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
      ),
      (
        'arena.reject_guarded_tier_a_source_transition()',
        '092fb4f654b1aa9a282416af46c172ad100bcbd3cf06c08a14369420b70dbd9c',
        true,
        'v',
        'plpgsql',
        'trigger',
        ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
      ),
      (
        'arena.bind_tier_a_execution_attempt()',
        '41a9579b95e204ad09597c0cd044bad4ebcebeffc55682f8ca626d5eabf4f45b',
        true,
        'v',
        'plpgsql',
        'trigger',
        ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
      ),
      (
        'arena.assert_tier_a_execution_outcome()',
        '8515ac2f89771ecd386e7f2120287faccd64a0d8f3987b78fe93ec9e954c1db0',
        true,
        'v',
        'plpgsql',
        'trigger',
        ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
      ),
      (
        'arena.tier_a_execution_claim_json(arena.tier_a_execution_claims)',
        'f9274aae424c4a9d2f99ccc77feeeee9f5fd3de2d51e6bbf3fa217784184be62',
        false,
        's',
        'sql',
        'jsonb',
        ARRAY[
          'search_path=pg_catalog, pg_temp',
          'TimeZone=UTC'
        ]::pg_catalog.text[]
      ),
      (
        'arena.assert_tier_a_execution_fence_at_commit()',
        '376421b57d55b7d4638952fb538df9a255bb0441c78e0fccb22f431b3cb4933d',
        true,
        'v',
        'plpgsql',
        'trigger',
        ARRAY[
          'search_path=pg_catalog, pg_temp',
          'TimeZone=UTC',
          'lock_timeout=5s',
          'statement_timeout=30s'
        ]::pg_catalog.text[]
      ),
      (
        'arena.tier_a_execution_receipt_json(arena.tier_a_execution_window_receipts)',
        'b988b5aeb72c7078a50fbbb267aac981be653de83db7cce955f872d2446277a9',
        false,
        's',
        'sql',
        'jsonb',
        ARRAY[
          'search_path=pg_catalog, pg_temp',
          'TimeZone=UTC'
        ]::pg_catalog.text[]
      )
  ),
  function_contract AS (
    SELECT
      pg_catalog.count(function_row.oid) = 16
      AND pg_catalog.bool_and(
        COALESCE(
          function_row.oid IS NOT NULL
          AND function_row.prokind = 'f'
          AND function_row.proowner = pg_catalog.to_regrole('postgres')
          AND function_row.prosecdef = expected.security_definer
          AND function_row.provolatile::text = expected.volatility
          AND NOT function_row.proretset
          AND NOT function_row.proisstrict
          AND NOT function_row.proleakproof
          AND function_row.proparallel = 'u'
          AND function_row.proargmodes IS NULL
          AND language_row.lanname = expected.language_name
          AND function_row.prorettype = pg_catalog.to_regtype(expected.return_type)
          AND function_row.proconfig IS NOT DISTINCT FROM expected.config
          AND pg_catalog.encode(
                pg_catalog.sha256(
                  pg_catalog.convert_to(function_row.prosrc, 'UTF8')
                ),
                'hex'
              ) = expected.source_sha256
          AND pg_catalog.has_function_privilege(
                'service_role', function_row.oid, 'EXECUTE'
              ) IS FALSE
          AND pg_catalog.has_function_privilege(
                'anon', function_row.oid, 'EXECUTE'
              ) IS FALSE
          AND pg_catalog.has_function_privilege(
                'authenticated', function_row.oid, 'EXECUTE'
              ) IS FALSE
          AND NOT EXISTS (
            SELECT 1
            FROM pg_catalog.aclexplode(
              COALESCE(
                function_row.proacl,
                pg_catalog.acldefault('f', function_row.proowner)
              )
            ) AS acl_row
            WHERE acl_row.privilege_type = 'EXECUTE'
              AND acl_row.grantee <> function_row.proowner
          ),
          false
        )
      ) AS exact
    FROM expected_functions AS expected
    LEFT JOIN pg_catalog.pg_proc AS function_row
      ON function_row.oid = pg_catalog.to_regprocedure(expected.signature)
    LEFT JOIN pg_catalog.pg_language AS language_row
      ON language_row.oid = function_row.prolang
  ),
  target_trigger_tables(table_oid) AS (
    VALUES
      (pg_catalog.to_regclass('arena.sources')),
      (pg_catalog.to_regclass('arena.leaderboard_snapshots')),
      (pg_catalog.to_regclass('arena.raw_objects')),
      (pg_catalog.to_regclass('arena.upstream_field_inventory')),
      (pg_catalog.to_regclass('arena.leaderboard_acquisition_attempts')),
      (pg_catalog.to_regclass('arena.leaderboard_acquisition_outcomes')),
      (pg_catalog.to_regclass('arena.tier_a_execution_claims')),
      (pg_catalog.to_regclass('arena.tier_a_execution_heads')),
      (pg_catalog.to_regclass('arena.tier_a_execution_write_guards')),
      (pg_catalog.to_regclass('arena.tier_a_execution_window_receipts'))
  ),
  trigger_rows AS (
    SELECT pg_catalog.concat_ws(
      '|',
      table_namespace.nspname,
      table_row.relname,
      trigger_row.tgname,
      trigger_row.tgenabled::text,
      function_namespace.nspname,
      function_row.proname || '(' ||
        pg_catalog.pg_get_function_identity_arguments(function_row.oid) || ')',
      trigger_row.tgtype::text,
      CASE WHEN trigger_row.tgdeferrable THEN '1' ELSE '0' END,
      CASE WHEN trigger_row.tginitdeferred THEN '1' ELSE '0' END,
      CASE WHEN trigger_row.tgconstraint <> 0 THEN '1' ELSE '0' END,
      trigger_row.tgconstrrelid::text,
      trigger_row.tgparentid::text,
      trigger_row.tgattr::text,
      COALESCE(
        pg_catalog.pg_get_expr(trigger_row.tgqual, trigger_row.tgrelid, true),
        '<NULL>'
      ),
      pg_catalog.octet_length(trigger_row.tgargs)::text
    ) AS canonical_row
    FROM target_trigger_tables AS target
    JOIN pg_catalog.pg_trigger AS trigger_row
      ON trigger_row.tgrelid = target.table_oid
     AND NOT trigger_row.tgisinternal
    JOIN pg_catalog.pg_class AS table_row
      ON table_row.oid = trigger_row.tgrelid
    JOIN pg_catalog.pg_namespace AS table_namespace
      ON table_namespace.oid = table_row.relnamespace
    JOIN pg_catalog.pg_proc AS function_row
      ON function_row.oid = trigger_row.tgfoid
    JOIN pg_catalog.pg_namespace AS function_namespace
      ON function_namespace.oid = function_row.pronamespace
  ),
  trigger_contract AS (
    SELECT
      pg_catalog.count(*) = 21
      AND pg_catalog.encode(
            pg_catalog.sha256(
              pg_catalog.convert_to(
                COALESCE(
                  pg_catalog.string_agg(
                    canonical_row,
                    E'\\n'
                    ORDER BY canonical_row
                  ),
                  ''
                ),
                'UTF8'
              )
            ),
            'hex'
          ) = '${TIER_A_EXECUTION_TRIGGER_CATALOG_SHA256}' AS exact
    FROM trigger_rows
  ),
  attempt_execution_columns AS (
    SELECT COALESCE(
      pg_catalog.array_agg(attribute.attnum ORDER BY attribute.attnum),
      ARRAY[]::smallint[]
    ) AS attnums
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid =
          pg_catalog.to_regclass('arena.leaderboard_acquisition_attempts')
      AND attribute.attname IN (
        'execution_claim_id',
        'execution_generation_seq'
      )
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ),
  constraint_rows AS (
    SELECT pg_catalog.concat_ws(
      '|',
      table_namespace.nspname,
      table_row.relname,
      constraint_row.conname,
      constraint_row.contype::text,
      CASE WHEN constraint_row.convalidated THEN '1' ELSE '0' END,
      CASE WHEN constraint_row.connoinherit THEN '1' ELSE '0' END,
      CASE WHEN constraint_row.conislocal THEN '1' ELSE '0' END,
      constraint_row.coninhcount::text,
      constraint_row.conparentid::text,
      CASE WHEN constraint_row.condeferrable THEN '1' ELSE '0' END,
      CASE WHEN constraint_row.condeferred THEN '1' ELSE '0' END,
      pg_catalog.encode(
        pg_catalog.sha256(
          pg_catalog.convert_to(
            pg_catalog.pg_get_constraintdef(constraint_row.oid, true),
            'UTF8'
          )
        ),
        'hex'
      )
    ) AS canonical_row
    FROM pg_catalog.pg_constraint AS constraint_row
    JOIN pg_catalog.pg_class AS table_row
      ON table_row.oid = constraint_row.conrelid
    JOIN pg_catalog.pg_namespace AS table_namespace
      ON table_namespace.oid = table_row.relnamespace
    CROSS JOIN attempt_execution_columns
    WHERE constraint_row.conrelid IN (
      pg_catalog.to_regclass('arena.tier_a_execution_claims'),
      pg_catalog.to_regclass('arena.tier_a_execution_heads'),
      pg_catalog.to_regclass('arena.tier_a_execution_write_guards'),
      pg_catalog.to_regclass('arena.tier_a_execution_window_receipts')
    )
    OR (
      constraint_row.conrelid =
        pg_catalog.to_regclass('arena.leaderboard_acquisition_attempts')
      AND (
        pg_catalog.starts_with(
          constraint_row.conname::text,
          'leaderboard_acquisition_attempts_execution_'
        )
        OR COALESCE(
             constraint_row.conkey,
             ARRAY[]::smallint[]
           ) && attempt_execution_columns.attnums
        OR constraint_row.confrelid =
           pg_catalog.to_regclass('arena.tier_a_execution_claims')
      )
    )
  ),
  constraint_contract AS (
    SELECT
      pg_catalog.count(*) = 65
      AND pg_catalog.encode(
            pg_catalog.sha256(
              pg_catalog.convert_to(
                COALESCE(
                  pg_catalog.string_agg(
                    canonical_row,
                    E'\\n'
                    ORDER BY canonical_row
                  ),
                  ''
                ),
                'UTF8'
              )
            ),
            'hex'
          ) = '${TIER_A_EXECUTION_CONSTRAINT_CATALOG_SHA256}' AS exact
    FROM constraint_rows
  ),
  business_tables(table_oid) AS (
    VALUES
      (pg_catalog.to_regclass('arena.leaderboard_snapshots')),
      (pg_catalog.to_regclass('arena.raw_objects')),
      (pg_catalog.to_regclass('arena.upstream_field_inventory')),
      (pg_catalog.to_regclass('arena.leaderboard_acquisition_attempts')),
      (pg_catalog.to_regclass('arena.leaderboard_acquisition_outcomes'))
  ),
  substrate_tables(table_oid) AS (
    VALUES
      (pg_catalog.to_regclass('arena.tier_a_execution_claims')),
      (pg_catalog.to_regclass('arena.tier_a_execution_heads')),
      (pg_catalog.to_regclass('arena.tier_a_execution_write_guards')),
      (pg_catalog.to_regclass('arena.tier_a_execution_window_receipts'))
  ),
  table_contract AS (
    SELECT
      (
        SELECT pg_catalog.count(table_row.oid) = 5
          AND pg_catalog.bool_and(
            table_row.relowner = pg_catalog.to_regrole('postgres')
            AND table_row.relkind = 'r'
          )
        FROM business_tables AS target
        LEFT JOIN pg_catalog.pg_class AS table_row
          ON table_row.oid = target.table_oid
      )
      AND NOT EXISTS (
        SELECT 1
        FROM business_tables AS target
        JOIN pg_catalog.pg_class AS table_row
          ON table_row.oid = target.table_oid
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(
            table_row.relacl,
            pg_catalog.acldefault('r', table_row.relowner)
          )
        ) AS acl_row
        WHERE acl_row.grantee <> table_row.relowner
          AND acl_row.privilege_type IN (
            'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER',
            'MAINTAIN'
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM business_tables AS target
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = target.table_oid
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
         AND attribute.attacl IS NOT NULL
        CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_row
        WHERE acl_row.privilege_type IN ('INSERT', 'UPDATE', 'REFERENCES')
      )
      AND (
        SELECT pg_catalog.count(table_row.oid) = 4
          AND pg_catalog.bool_and(
            table_row.relowner = pg_catalog.to_regrole('postgres')
            AND table_row.relkind = 'r'
            AND table_row.relrowsecurity
          )
        FROM substrate_tables AS target
        LEFT JOIN pg_catalog.pg_class AS table_row
          ON table_row.oid = target.table_oid
      )
      AND NOT EXISTS (
        SELECT 1
        FROM substrate_tables AS target
        JOIN pg_catalog.pg_class AS table_row
          ON table_row.oid = target.table_oid
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(
            table_row.relacl,
            pg_catalog.acldefault('r', table_row.relowner)
          )
        ) AS acl_row
        WHERE acl_row.grantee <> table_row.relowner
      )
      AND NOT EXISTS (
        SELECT 1
        FROM substrate_tables AS target
        JOIN pg_catalog.pg_class AS table_row
          ON table_row.oid = target.table_oid
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = table_row.oid
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
         AND attribute.attacl IS NOT NULL
        CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_row
        WHERE acl_row.grantee <> table_row.relowner
      )
      AND EXISTS (
        SELECT 1
        FROM pg_catalog.pg_class AS source_table
        WHERE source_table.oid = pg_catalog.to_regclass('arena.sources')
          AND source_table.relowner = pg_catalog.to_regrole('postgres')
          AND source_table.relkind = 'r'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_class AS source_table
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(
            source_table.relacl,
            pg_catalog.acldefault('r', source_table.relowner)
          )
        ) AS acl_row
        WHERE source_table.oid = pg_catalog.to_regclass('arena.sources')
          AND acl_row.grantee <> source_table.relowner
          AND acl_row.privilege_type IN ('TRIGGER', 'REFERENCES', 'MAINTAIN')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_attribute AS attribute
        CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_row
        WHERE attribute.attrelid = pg_catalog.to_regclass('arena.sources')
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
          AND attribute.attacl IS NOT NULL
          AND acl_row.privilege_type = 'REFERENCES'
      ) AS exact
  ),
  substrate_contract AS (
    SELECT
      pg_catalog.current_setting('server_version_num')::integer
        BETWEEN 170000 AND 179999
      AND COALESCE(column_contract.exact, false)
      AND COALESCE(function_contract.exact, false)
      AND COALESCE(trigger_contract.exact, false)
      AND COALESCE(constraint_contract.exact, false)
      AND COALESCE(table_contract.exact, false) AS exact
    FROM column_contract
    CROSS JOIN function_contract
    CROSS JOIN trigger_contract
    CROSS JOIN constraint_contract
    CROSS JOIN table_contract
  )
  SELECT
    marker.oid IS NOT NULL AS marker_present,
    CASE
      WHEN marker.oid IS NULL THEN NULL
      ELSE pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(marker.prosrc, 'UTF8')),
        'hex'
      )
    END AS marker_rpc_sha256,
    COALESCE(
      marker.prokind = 'f'
      AND marker.proowner = 'postgres'::pg_catalog.regrole
      AND marker.prosecdef
      AND marker.provolatile = 's'
      AND NOT marker.proretset
      AND NOT marker.proisstrict
      AND NOT marker.proleakproof
      AND marker.proparallel = 'u'
      AND marker.pronargs = 0
      AND marker.proargmodes IS NULL
      AND marker.prorettype = 'jsonb'::pg_catalog.regtype
      AND language_row.lanname = 'sql'
      AND pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(marker.prosrc, 'UTF8')),
        'hex'
      ) = '${TIER_A_EXECUTION_ENFORCEMENT_MARKER_RPC_SHA256}'
      AND marker.proconfig @> ARRAY[
        'search_path=pg_catalog, pg_temp',
        'statement_timeout=10s'
      ]::pg_catalog.text[]
      AND pg_catalog.cardinality(marker.proconfig) = 2,
      false
    ) AS marker_contract_exact,
    COALESCE(
      pg_catalog.has_function_privilege(
        'service_role', marker.oid, 'EXECUTE'
      )
      AND NOT pg_catalog.has_function_privilege(
        'anon', marker.oid, 'EXECUTE'
      )
      AND NOT pg_catalog.has_function_privilege(
        'authenticated', marker.oid, 'EXECUTE'
      )
      AND EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(
          COALESCE(
            marker.proacl,
            pg_catalog.acldefault('f', marker.proowner)
          )
        ) AS acl_row
        WHERE acl_row.privilege_type = 'EXECUTE'
          AND acl_row.grantee = 'service_role'::pg_catalog.regrole
          AND NOT acl_row.is_grantable
      )
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(
          COALESCE(
            marker.proacl,
            pg_catalog.acldefault('f', marker.proowner)
          )
        ) AS acl_row
        WHERE acl_row.privilege_type = 'EXECUTE'
          AND acl_row.grantee <> marker.proowner
          AND (
            acl_row.grantee <> 'service_role'::pg_catalog.regrole
            OR acl_row.is_grantable
          )
      ),
      false
    ) AS marker_acl_exact,
    COALESCE(
      marker.oid IS NOT NULL
      AND substrate_contract.exact,
      false
    ) AS substrate_contract_exact
  FROM marker_identity
  LEFT JOIN pg_catalog.pg_proc AS marker
    ON marker.oid = marker_identity.marker_oid
  LEFT JOIN pg_catalog.pg_language AS language_row
    ON language_row.oid = marker.prolang
  CROSS JOIN substrate_contract`

const ENFORCEMENT_MARKER_SQL = `SELECT arena.tier_a_execution_claim_enforcement_state() AS enforcement_state`

type ReadinessQueryResult = {
  rowCount: number | null
  rows: Array<Record<string, unknown>>
}

export type AttemptBoundCaptureReadinessClient = {
  query: (sql: string) => Promise<ReadinessQueryResult>
  release: () => void
}

type ConnectReadinessClient = () => Promise<AttemptBoundCaptureReadinessClient>
type LoadReadiness = () => Promise<unknown>

export type PartitionedV4WorkerReadiness = {
  contract: typeof PARTITIONED_V4_WORKER_READINESS_CONTRACT
  enforcement: Record<string, unknown>
  registry: Array<Record<string, unknown>>
  rpc: Record<string, unknown>
}

function startupGateError(reason: string): Error {
  return new Error(`[ingest-worker] partitioned V4 startup gate failed closed: ${reason}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
}

export function validatePartitionedV4WorkerReadiness(payload: unknown): void {
  if (
    !isRecord(payload) ||
    !hasExactKeys(payload, ['contract', 'enforcement', 'registry', 'rpc'])
  ) {
    throw startupGateError('readiness payload is malformed')
  }
  if (payload.contract !== PARTITIONED_V4_WORKER_READINESS_CONTRACT) {
    throw startupGateError('readiness contract is not exact')
  }
  if (!Array.isArray(payload.registry) || payload.registry.length !== 2) {
    throw startupGateError('capture registry cardinality is not exact')
  }
  for (const [index, sourceSlug] of EXPECTED_SOURCE_SLUGS.entries()) {
    const row = payload.registry[index]
    const futures = sourceSlug === 'bitget_bots_futures'
    if (
      !isRecord(row) ||
      !hasExactKeys(row, REGISTRY_ROW_KEYS) ||
      row.source_slug !== sourceSlug ||
      row.exchange_slug !== 'bitget' ||
      row.source_adapter_slug !== 'bitget_bots' ||
      row.product_type !== (futures ? 'futures' : 'spot') ||
      row.trader_kind_scope !== 'bot' ||
      row.status !== 'active' ||
      row.serving_mode !== 'serving' ||
      row.currency !== 'USDT' ||
      JSON.stringify(row.timeframes_native) !== JSON.stringify([30]) ||
      JSON.stringify(row.timeframes_derived) !== JSON.stringify([]) ||
      row.page_size !== 20 ||
      row.pagination_kind !== 'numeric' ||
      JSON.stringify(row.boards) !==
        JSON.stringify(
          futures ? ['futures_grid', 'futures_martingale'] : ['spot_grid', 'spot_martingale']
        ) ||
      row.cadence_contract_exact !== true ||
      row.capture_contract !== PARTITIONED_V4_CAPTURE_CONTRACT ||
      row.adapter_slug !== 'bitget_bots' ||
      row.attempt_binding_contract !== PARTITIONED_V4_ATTEMPT_BINDING_CONTRACT ||
      row.requires_runner_git_sha !== true
    ) {
      throw startupGateError('capture registry is not exact')
    }
  }
  if (!isRecord(payload.rpc) || !hasExactKeys(payload.rpc, RPC_ROW_KEYS)) {
    throw startupGateError('acquisition RPC proof is malformed')
  }
  if (
    payload.rpc.legacy_start_rpc_sha256 !== PARTITIONED_V4_START_RPC_SHA256 ||
    payload.rpc.legacy_finish_rpc_sha256 !== PARTITIONED_V4_FINISH_RPC_SHA256 ||
    payload.rpc.claimed_start_rpc_sha256 !== PARTITIONED_V4_CLAIMED_START_RPC_SHA256 ||
    payload.rpc.claimed_finish_rpc_sha256 !== PARTITIONED_V4_CLAIMED_FINISH_RPC_SHA256 ||
    payload.rpc.execution_claim_rpc_sha256 !== TIER_A_EXECUTION_CLAIM_RPC_SHA256 ||
    payload.rpc.execution_heartbeat_rpc_sha256 !== TIER_A_EXECUTION_HEARTBEAT_RPC_SHA256 ||
    payload.rpc.execution_assert_rpc_sha256 !== TIER_A_EXECUTION_ASSERT_RPC_SHA256 ||
    payload.rpc.execution_close_rpc_sha256 !== TIER_A_EXECUTION_CLOSE_RPC_SHA256 ||
    payload.rpc.execution_record_receipt_rpc_sha256 !==
      TIER_A_EXECUTION_RECORD_RECEIPT_RPC_SHA256 ||
    payload.rpc.execution_get_receipt_rpc_sha256 !== TIER_A_EXECUTION_GET_RECEIPT_RPC_SHA256 ||
    payload.rpc.legacy_contract_exact !== true ||
    payload.rpc.claimed_runtime_contract_exact !== true ||
    payload.rpc.claimed_runtime_acl_exact !== true
  ) {
    throw startupGateError('acquisition RPC contract is not exact')
  }
  if (!isRecord(payload.enforcement) || !hasExactKeys(payload.enforcement, ENFORCEMENT_ROW_KEYS)) {
    throw startupGateError('execution enforcement proof is malformed')
  }

  if (payload.enforcement.state === 'expand') {
    if (
      payload.enforcement.marker_present !== false ||
      payload.enforcement.marker_rpc_sha256 !== null ||
      payload.enforcement.marker_contract_exact !== false ||
      payload.enforcement.marker_acl_exact !== false ||
      payload.enforcement.substrate_contract_exact !== false ||
      payload.enforcement.marker_payload !== null ||
      payload.rpc.legacy_expand_acl_exact !== true ||
      payload.rpc.legacy_enforced_acl_exact !== false
    ) {
      throw startupGateError('expand execution enforcement state is not exact')
    }
    return
  }

  if (payload.enforcement.state === 'enforced') {
    const markerPayload = payload.enforcement.marker_payload
    if (
      payload.enforcement.marker_present !== true ||
      payload.enforcement.marker_rpc_sha256 !== TIER_A_EXECUTION_ENFORCEMENT_MARKER_RPC_SHA256 ||
      payload.enforcement.marker_contract_exact !== true ||
      payload.enforcement.marker_acl_exact !== true ||
      payload.enforcement.substrate_contract_exact !== true ||
      !isRecord(markerPayload) ||
      !hasExactKeys(markerPayload, ENFORCEMENT_MARKER_PAYLOAD_KEYS) ||
      markerPayload.contract !== TIER_A_EXECUTION_CLAIM_ENFORCEMENT_CONTRACT ||
      markerPayload.state !== 'enforced' ||
      payload.rpc.legacy_expand_acl_exact !== false ||
      payload.rpc.legacy_enforced_acl_exact !== true
    ) {
      throw startupGateError('enforced execution enforcement state is not exact')
    }
    return
  }

  throw startupGateError('execution enforcement state is not exact')
}

async function connectDefault(): Promise<AttemptBoundCaptureReadinessClient> {
  const client = await ingestClientConnect()
  return {
    query: async (sql) => {
      const result = await client.query(sql)
      return {
        rowCount: result.rowCount,
        rows: result.rows as Array<Record<string, unknown>>,
      }
    },
    release: () => client.release(),
  }
}

export async function loadPartitionedV4WorkerReadiness({
  connect = connectDefault,
}: {
  connect?: ConnectReadinessClient
} = {}): Promise<PartitionedV4WorkerReadiness> {
  const client = await connect()
  let inTransaction = false
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    inTransaction = true
    await client.query("SET LOCAL statement_timeout = '10s'")
    await client.query('SET LOCAL search_path = pg_catalog, pg_temp')
    const registry = await client.query(REGISTRY_SQL)
    const enforcementProof = await client.query(TIER_A_EXECUTION_ENFORCEMENT_CATALOG_SQL)
    const rpc = await client.query(RPC_SQL)
    if (registry.rowCount !== 2 || registry.rows.length !== 2) {
      throw startupGateError('capture registry row cardinality is not exact')
    }
    if (enforcementProof.rowCount !== 1 || enforcementProof.rows.length !== 1) {
      throw startupGateError('execution enforcement row cardinality is not exact')
    }
    if (rpc.rowCount !== 1 || rpc.rows.length !== 1) {
      throw startupGateError('acquisition RPC row cardinality is not exact')
    }
    const enforcementCatalog = enforcementProof.rows[0]
    let markerPayload: unknown = null
    if (
      enforcementCatalog.marker_present === true &&
      enforcementCatalog.marker_contract_exact === true &&
      enforcementCatalog.marker_acl_exact === true &&
      enforcementCatalog.substrate_contract_exact === true &&
      enforcementCatalog.marker_rpc_sha256 === TIER_A_EXECUTION_ENFORCEMENT_MARKER_RPC_SHA256
    ) {
      const marker = await client.query(ENFORCEMENT_MARKER_SQL)
      if (
        marker.rowCount !== 1 ||
        marker.rows.length !== 1 ||
        !hasExactKeys(marker.rows[0], ['enforcement_state'])
      ) {
        throw startupGateError('execution enforcement marker cardinality is not exact')
      }
      markerPayload = marker.rows[0].enforcement_state
    }
    await client.query('COMMIT')
    inTransaction = false
    return {
      contract: PARTITIONED_V4_WORKER_READINESS_CONTRACT,
      enforcement: {
        ...enforcementCatalog,
        marker_payload: markerPayload,
        state: enforcementCatalog.marker_present === true ? 'enforced' : 'expand',
      },
      registry: registry.rows,
      rpc: rpc.rows[0],
    }
  } catch (error) {
    if (inTransaction) {
      await client.query('ROLLBACK').catch(() => undefined)
    }
    throw error
  } finally {
    client.release()
  }
}

export async function assertPartitionedV4WorkerReadiness({
  load = loadPartitionedV4WorkerReadiness,
  timeoutMs = 15_000,
}: {
  load?: LoadReadiness
  timeoutMs?: number
} = {}): Promise<void> {
  let payload: unknown
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    payload = await Promise.race([
      load(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(startupGateError('readiness query timed out')), timeoutMs)
      }),
    ])
  } catch {
    throw startupGateError('readiness query is unavailable')
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
  validatePartitionedV4WorkerReadiness(payload)
}
