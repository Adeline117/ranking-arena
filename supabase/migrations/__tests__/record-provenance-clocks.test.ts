import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const migrationName = '20260803090000_record_provenance_clocks.sql'
const migration = readFileSync(resolve(process.cwd(), 'supabase/migrations', migrationName), 'utf8')
const priorCopierMigration = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20260729014000_bitget_bot_copier_aggregate_authority.sql'
  ),
  'utf8'
)
const proof = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/__tests__/record-provenance-clocks.pg17.sh'),
  'utf8'
)
const servingTypes = readFileSync(resolve(process.cwd(), 'lib/data/serving/types.ts'), 'utf8')

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Extract one replacement body without allowing a later function declaration
 * to satisfy the match. The delimiter capture also keeps the test independent
 * of the chosen dollar-quote tag.
 */
function functionBody(sql: string, name: string): string {
  const marker = `CREATE OR REPLACE FUNCTION ${name}(`
  const start = sql.indexOf(marker)
  if (start < 0) throw new Error(`function declaration not found: ${name}`)

  const next = sql.indexOf('CREATE OR REPLACE FUNCTION ', start + marker.length)
  const declaration = sql.slice(start, next < 0 ? sql.length : next)
  const body = declaration.match(/\bAS\s+\$([a-zA-Z0-9_]*)\$([\s\S]*?)\$\1\$;/)?.[2]
  if (body === undefined) throw new Error(`function body not found: ${name}`)
  return body
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

const recordsBody = functionBody(migration, 'public.arena_records_page')
const copierBody = functionBody(migration, 'public.arena_copier_aggregate')
const priorCopierBody = functionBody(priorCopierMigration, 'public.arena_copier_aggregate')
const recordsBodyHash = sha256(recordsBody)
const copierBodyHash = sha256(copierBody)
const forbiddenRequestClock =
  /\b(?:pg_catalog\.)?(?:now|transaction_timestamp|statement_timestamp|clock_timestamp)\s*\(/i

describe('record provenance clock authority', () => {
  it('replaces exactly the two public readers without synthesizing request-time freshness', () => {
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1)
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1)
    expect(migration.match(/CREATE OR REPLACE FUNCTION /g)).toHaveLength(2)
    expect(recordsBody).not.toBe('')
    expect(copierBody).not.toBe('')

    for (const body of [recordsBody, copierBody]) {
      expect(body).not.toMatch(forbiddenRequestClock)
      expect(body).toContain("'asOf'")
      for (const clock of ['sourceAsOf', 'observedAt', 'publishedAt']) {
        expect(body).toContain(`'${clock}'`)
      }
    }
  })

  it('publishes the exact four-key client provenance model without collapsing clocks', () => {
    // The canonical source is supplied by the resolver/serving boundary. Each
    // SQL reader supplies the other three keys. The RPC still carries a
    // deprecated nullable asOf alias outside this client provenance object.
    const interfaceBody = servingTypes.match(
      /export interface RecordProvenance\s*{([\s\S]*?)\n}/
    )?.[1]
    const properties = [
      ...(interfaceBody?.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*)(?:\?)?:/gm) ?? []),
    ].map((match) => match[1])
    expect(properties).toEqual(['source', 'sourceAsOf', 'observedAt', 'publishedAt'])
    for (const body of [recordsBody, copierBody]) {
      expect(body.match(/'sourceAsOf'/g)?.length).toBeGreaterThan(0)
      expect(body.match(/'observedAt'/g)?.length).toBeGreaterThan(0)
      expect(body.match(/'publishedAt'/g)?.length).toBeGreaterThan(0)
      expect(body.match(/'asOf'/g)?.length).toBeGreaterThan(0)
    }
  })

  it('labels position source time only behind the explicit non-negative delay contract', () => {
    const positions = recordsBody.slice(
      recordsBody.indexOf("IF p_kind = 'positions' THEN"),
      recordsBody.indexOf("ELSIF p_kind = 'position_history' THEN")
    )
    expect(positions).not.toBe('')
    expect(recordsBody).toContain("v_source_meta->'positions_delay_hours'")
    expect(recordsBody).toContain("pg_catalog.jsonb_typeof(v_source_meta->'positions_delay_hours')")
    expect(recordsBody).toMatch(/positions_delay_hours[\s\S]*?>= 0/)
    expect(positions).toMatch(
      /v_source_as_of\s*:=\s*CASE[\s\S]*?v_positions_delay_hours\s*>=\s*0[\s\S]*?END/
    )
    expect(positions).toMatch(/'sourceAsOf'\s*,\s*v_source_as_of/)
    expect(positions).not.toMatch(/'sourceAsOf'\s*,\s*(?:v_)?snapshot_at/)

    const legacyAsOf = positions.match(/'asOf'\s*,([\s\S]*?),\s*'sourceAsOf'\s*,/)?.[1]
    const sourceAsOf = positions.match(/'sourceAsOf'\s*,([\s\S]*?),\s*'observedAt'\s*,/)?.[1]
    expect(legacyAsOf).toBeDefined()
    expect(sourceAsOf).toBeDefined()
    expect(legacyAsOf?.replace(/\s+/g, ' ').trim()).toBe(sourceAsOf?.replace(/\s+/g, ' ').trim())
  })

  it('maps the position storage snapshot only to publication time', () => {
    const positions = recordsBody.slice(
      recordsBody.indexOf("IF p_kind = 'positions' THEN"),
      recordsBody.indexOf("ELSIF p_kind = 'position_history' THEN")
    )
    expect(positions).toMatch(/\bmax\(snapshot_at\)/)
    expect(positions).toMatch(/'publishedAt'\s*,\s*v_published_at/)
    expect(positions).not.toMatch(/'sourceAsOf'\s*,\s*(?:v_)?snapshot_at/)
    expect(positions).not.toMatch(/'observedAt'\s*,\s*(?:v_)?snapshot_at/)
  })

  it('never promotes history event or cursor time into provenance', () => {
    const historyReturn = recordsBody.slice(recordsBody.lastIndexOf('RETURN jsonb_build_object('))
    expect(historyReturn).not.toBe('')
    expect(historyReturn).toMatch(/'asOf'\s*,\s*NULL/)
    expect(historyReturn).toMatch(/'sourceAsOf'\s*,\s*NULL/)
    expect(historyReturn).toMatch(/'observedAt'\s*,\s*NULL/)
    expect(historyReturn).toMatch(/'publishedAt'\s*,\s*NULL/)
    expect(historyReturn).toContain('v_last_ts')
    expect(historyReturn).not.toMatch(
      /'(?:sourceAsOf|observedAt|publishedAt)'\s*,\s*(?:v_last_ts|closed_at|opened_at|ts)\b/
    )
  })

  it('preserves the latest strict Bitget bot copier authority', () => {
    for (const contract of [
      "'bitget_bots_futures'",
      "'bitget_bots_spot'",
      "exchange_row.slug = 'bitget'",
      "source_row.adapter_slug = 'bitget_bots'",
      "source_row.trader_kind_scope = 'bot'",
      "source_row.status = 'active'",
      "source_row.serving_mode = 'serving'",
      'source_row.timeframes_native = ARRAY[30]::integer[]',
      'source_row.timeframes_derived = ARRAY[]::integer[]',
      'source_row.page_size = 20',
      "source_row.pagination_kind = 'numeric'",
      "source_row.copier_table_depth = 'top10'",
      'resolved.canonical_bitget_bot',
      'batch_contract.row_count BETWEEN 1 AND 10',
      'trusted_bot_stats AS (',
      'stats.timeframe = 0',
      "stats.extras -> '_arena_profile_publication_epoch_ms'",
    ]) {
      expect(copierBody).toContain(contract)
    }
    expect(copierBody).toMatch(
      /_arena_profile_publication_epoch_ms'[\s\S]*?::pg_catalog\.numeric\s*=\s*EXTRACT\(EPOCH FROM stats\.as_of\) \* 1000/
    )
    expect(copierBody).toMatch(
      /WHEN resolved\.is_bitget_bot\s+THEN \(SELECT stats\.copier_count FROM trusted_bot_stats/
    )
    expect(copierBody).toMatch(
      /WHEN resolved\.is_bitget_bot\s+THEN \(SELECT stats\.copier_pnl FROM trusted_bot_stats/
    )
    expect(copierBody).not.toContain('copier_label')
    expect(copierBody).toMatch(/'asOf'\s*,\s*NULL/)
  })

  it('changes only the copier provenance output block from the latest strict authority body', () => {
    const provenanceBlock = /'asOf'\s*,[\s\S]*?(?='pnlDistribution'\s*,)/g
    const normalizeSql = (value: string) =>
      value
        .replace(/--[^\n]*/g, '')
        .replace(/\s+/g, ' ')
        .trim()
    expect(priorCopierBody.match(provenanceBlock)).toHaveLength(1)
    expect(copierBody.match(provenanceBlock)).toHaveLength(1)
    expect(normalizeSql(copierBody.replace(provenanceBlock, "'provenanceClocks', NULL,"))).toBe(
      normalizeSql(priorCopierBody.replace(provenanceBlock, "'provenanceClocks', NULL,"))
    )
  })

  it('keeps both readers inside the hardened catalog and exact browser ACL envelope', () => {
    expect(migration).toContain('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    expect(migration).toContain('SET LOCAL search_path = pg_catalog, pg_temp')
    expect(migration).toContain("pg_catalog.current_setting('server_version_num')")
    expect(migration).toContain('record-provenance-clocks')

    expect(migration).toMatch(
      /FUNCTION public\.arena_records_page\([\s\S]*?RETURNS jsonb[\s\S]*?LANGUAGE plpgsql[\s\S]*?STABLE[\s\S]*?SECURITY DEFINER[\s\S]*?SET search_path = pg_catalog, pg_temp/
    )
    expect(migration).toMatch(
      /FUNCTION public\.arena_copier_aggregate\([\s\S]*?RETURNS jsonb[\s\S]*?LANGUAGE sql[\s\S]*?STABLE[\s\S]*?SECURITY DEFINER[\s\S]*?SET search_path = pg_catalog, pg_temp/
    )

    for (const signature of [
      'public.arena_records_page(text, text, text, int, text, int)',
      'public.arena_copier_aggregate(text, text)',
    ]) {
      const escaped = escapeRegExp(signature)
      expect(migration).toMatch(new RegExp(`ALTER FUNCTION ${escaped}\\s+OWNER TO postgres;`))
      expect(migration).toMatch(
        new RegExp(
          `REVOKE ALL ON FUNCTION ${escaped}\\s+FROM PUBLIC, anon, authenticated, service_role;`
        )
      )
      expect(migration).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION ${escaped}\\s+TO anon, authenticated, service_role;`)
      )
    }
    expect(migration).toContain('pg_catalog.aclexplode')
    expect(migration).toContain('privilege.grantee = 0::oid')
  })

  it('recomputes and finds both exact replacement-body hashes in postflight', () => {
    expect(recordsBodyHash).toMatch(/^[0-9a-f]{64}$/)
    expect(copierBodyHash).toMatch(/^[0-9a-f]{64}$/)
    expect(recordsBodyHash).not.toBe(copierBodyHash)
    expect(migration).toContain(recordsBodyHash)
    expect(migration).toContain(copierBodyHash)
    expect(migration).toContain('pg_catalog.sha256')
    expect(migration).toContain('pg_catalog.convert_to')
  })

  it('ships executable PG17 proofs for clocks, delay gates, authority and ACL replay', () => {
    for (const marker of [
      'legacy history did not reproduce read-time asOf',
      'explicit-delay position clocks drifted',
      'untrusted delay exposed source freshness',
      'empty positions synthesized provenance',
      'event surface fabricated provenance',
      'trusted Bitget bot totals/distribution',
      'Top-10-only Bitget bot semantics regressed',
      'callable ACL/metadata drifted',
      'record provenance clocks PostgreSQL 17 proof passed',
    ]) {
      expect(proof).toContain(marker)
    }

    // PostgreSQL three-valued logic must not let a missing JSON key make an
    // assertion evaluate to NULL (and therefore silently pass an IF guard).
    for (const key of ['asOf', 'sourceAsOf', 'observedAt', 'publishedAt']) {
      expect(proof).toContain(`v_payload->'${key}' IS DISTINCT FROM 'null'::jsonb`)
    }
    expect(proof).not.toMatch(
      /v_payload->'(?:asOf|sourceAsOf|observedAt|publishedAt)'\s*(?:<>|=)\s*'null'::jsonb/
    )

    expect(proof).toContain('function_metadata_fingerprint()')
    expect(proof).toContain('rpc_output_fingerprint()')
    expect(proof).toContain('pg_catalog.pg_get_functiondef(function_row.oid)')
    expect(proof.match(/\bEXCEPT\b/g)).toHaveLength(2)
    for (const replaySurface of [
      'missingDelayPositions',
      'invalidDelayPositions',
      'negativeDelayPositions',
      'emptyPositions',
      'orders',
      'transfers',
      'humanCopier',
      'noEvidenceBot',
    ]) {
      expect(proof).toContain(`'${replaySurface}'`)
    }
  })
})
