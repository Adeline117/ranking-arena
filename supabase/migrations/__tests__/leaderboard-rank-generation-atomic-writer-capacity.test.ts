import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const sharedProofShell = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/__tests__/leaderboard-rank-generation-atomic-writer.pg17.sh'
  ),
  'utf8'
)
const capacityWrapper = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/__tests__/leaderboard-rank-generation-atomic-writer-capacity.pg17.sh'
  ),
  'utf8'
)
const capacityFixture = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/__tests__/fixtures/leaderboard-rank-generation-64k-benchmark.pg17.psql'
  ),
  'utf8'
)

// Full-line comments cannot satisfy this contract. Inline SQL strings remain because
// they are executable evidence (for example, a generated statement consumed by \gexec).
const withoutFullLineComments = (value: string): string =>
  value
    .replace(/^\s*#[^\n]*(?:\n|$)/gm, '')
    .replace(/^\s*--[^\n]*(?:\n|$)/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')

const sharedProofCode = withoutFullLineComments(sharedProofShell)
const capacityWrapperCode = withoutFullLineComments(capacityWrapper)
const capacityFixtureCode = withoutFullLineComments(capacityFixture)

const occurrenceCount = (value: string, pattern: RegExp): number =>
  value.match(new RegExp(pattern.source, pattern.flags.replace('g', '') + 'g'))?.length ?? 0

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const expectTermsNearEachOther = (
  value: string,
  first: string,
  second: string,
  maximumDistance = 2400
): void => {
  const firstThenSecond = new RegExp(
    `${escapeRegExp(first)}[\\s\\S]{0,${maximumDistance}}${escapeRegExp(second)}`,
    'i'
  )
  const secondThenFirst = new RegExp(
    `${escapeRegExp(second)}[\\s\\S]{0,${maximumDistance}}${escapeRegExp(first)}`,
    'i'
  )

  expect(firstThenSecond.test(value) || secondThenFirst.test(value)).toBe(true)
}

describe('leaderboard rank atomic writer durable 64k capacity gate', () => {
  it('keeps the ordinary proof fast but makes benchmark mode explicit and durable', () => {
    expect(sharedProofCode).toContain('BENCHMARK_64K="${ARENA_ATOMIC_WRITER_BENCHMARK_64K:-0}"')
    expect(sharedProofCode).toContain(
      'BENCHMARK_SCENARIO="${ARENA_ATOMIC_WRITER_BENCHMARK_SCENARIO:-insert}"'
    )
    expect(sharedProofCode).toMatch(/"\$BENCHMARK_64K" != '0' && "\$BENCHMARK_64K" != '1'/)
    expect(sharedProofCode).toMatch(
      /"\$BENCHMARK_SCENARIO" != 'insert' && "\$BENCHMARK_SCENARIO" != 'update'/
    )
    expect(sharedProofCode).toContain(
      'CAPACITY_BENCHMARK="$ROOT_DIR/supabase/migrations/__tests__/fixtures/leaderboard-rank-generation-64k-benchmark.pg17.psql"'
    )

    const startupBranches = sharedProofCode.match(
      /if \[\[ "\$BENCHMARK_64K" == '1' \]\]; then([\s\S]*?)\nelse\n([\s\S]*?)\nfi/
    )
    expect(startupBranches).toBeDefined()

    const benchmarkStartup = startupBranches?.[1] ?? ''
    const ordinaryStartup = startupBranches?.[2] ?? ''
    expect(benchmarkStartup).toContain('fsync=on')
    expect(benchmarkStartup).toContain('synchronous_commit=on')
    expect(benchmarkStartup).toContain('full_page_writes=on')
    expect(benchmarkStartup).not.toMatch(/(?:^|\s)-F(?:\s|$)/)
    expect(ordinaryStartup).toMatch(/POSTGRES_OPTIONS="-F\s/)

    const benchmarkDispatch = sharedProofCode.match(
      /if \[\[ "\$BENCHMARK_64K" == '1' \]\]; then([\s\S]*?)-f "\$CAPACITY_BENCHMARK"([\s\S]*?)exit 0\nfi/
    )
    expect(benchmarkDispatch).toBeDefined()
    expect(benchmarkDispatch?.[0]).toContain('-v benchmark_scenario="$BENCHMARK_SCENARIO"')
  })

  it('runs insert and update independently for one through five requested repetitions', () => {
    expect(capacityWrapperCode).toContain(
      'REPETITIONS="${ARENA_ATOMIC_WRITER_BENCHMARK_REPETITIONS:-1}"'
    )
    expect(capacityWrapperCode).toMatch(/\[\[ ! "\$REPETITIONS" =~ \^\[1-5\]\$ \]\]/)
    expect(capacityWrapperCode).toContain(
      'ARENA_ATOMIC_WRITER_BENCHMARK_REPETITIONS must be between 1 and 5'
    )

    const repetitionLoop = capacityWrapperCode.indexOf(
      'for ((repetition = 1; repetition <= REPETITIONS; repetition += 1)); do'
    )
    const scenarioLoop = capacityWrapperCode.indexOf('for scenario in insert update; do')
    const modeAssignment = capacityWrapperCode.indexOf(
      'ARENA_ATOMIC_WRITER_BENCHMARK_64K=1',
      scenarioLoop
    )
    const scenarioAssignment = capacityWrapperCode.indexOf(
      'ARENA_ATOMIC_WRITER_BENCHMARK_SCENARIO="$scenario"',
      modeAssignment
    )
    const proofInvocation = capacityWrapperCode.indexOf(
      '"$ROOT_DIR/supabase/migrations/__tests__/leaderboard-rank-generation-atomic-writer.pg17.sh"',
      scenarioAssignment
    )

    expect(repetitionLoop).toBeGreaterThan(-1)
    expect(scenarioLoop).toBeGreaterThan(repetitionLoop)
    expect(modeAssignment).toBeGreaterThan(scenarioLoop)
    expect(scenarioAssignment).toBeGreaterThan(modeAssignment)
    expect(proofInvocation).toBeGreaterThan(scenarioAssignment)
    expect(
      occurrenceCount(capacityWrapperCode, /leaderboard-rank-generation-atomic-writer\.pg17\.sh/)
    ).toBe(1)
    expect(capacityWrapperCode.slice(scenarioLoop, proofInvocation)).not.toContain('&')
  })

  it('builds a validated 100 by 640 population and dispatches 64 autocommit writes', () => {
    expect(capacityFixtureCode).toContain(":'benchmark_scenario'")
    expect(capacityFixtureCode).toMatch(/(?:NOT\s+)?IN\s*\(\s*'insert'\s*,\s*'update'\s*\)/i)
    expect(capacityFixtureCode).toMatch(/benchmark_scenario[\s\S]{0,1200}'update'/i)
    expect(capacityFixtureCode).toContain('64000')
    expect(capacityFixtureCode).toContain('64')
    expect(capacityFixtureCode).toContain('100')
    expect(capacityFixtureCode).toContain('640')

    const hasCartesianPopulation =
      /generate_series\(\s*(?:0\s*,\s*99|1\s*,\s*100)\s*\)[\s\S]{0,1600}generate_series\(\s*(?:0\s*,\s*639|1\s*,\s*640)\s*\)/i.test(
        capacityFixtureCode
      )
    const hasDerivedPopulation =
      /generate_series\(\s*(?:0\s*,\s*63999|1\s*,\s*64000)\s*\)[\s\S]{0,1600}(?:\/|%)\s*640/i.test(
        capacityFixtureCode
      )
    expect(hasCartesianPopulation || hasDerivedPopulation).toBe(true)

    expect(occurrenceCount(capacityFixtureCode, /\\gexec/)).toBe(1)
    const gexecIndex = capacityFixtureCode.indexOf('\\gexec')
    const helperStart = capacityFixtureCode.indexOf(
      'CREATE FUNCTION arena.fixture_write_rank_generation_64k_batch'
    )
    const helperEnd = capacityFixtureCode.indexOf('$body$;', helperStart)
    const writerIndex = capacityFixtureCode.indexOf(
      'arena.write_leaderboard_rank_generation_batch_v1',
      helperStart
    )
    const xidIndex = capacityFixtureCode.indexOf('pg_current_xact_id()', helperStart)
    const generatedStatementStart = capacityFixtureCode.lastIndexOf(
      'SELECT pg_catalog.format(',
      gexecIndex
    )
    const generatedWriterStatements = capacityFixtureCode.slice(
      generatedStatementStart,
      gexecIndex + '\\gexec'.length
    )

    expect(gexecIndex).toBeGreaterThan(-1)
    expect(helperStart).toBeGreaterThan(-1)
    expect(helperEnd).toBeGreaterThan(helperStart)
    expect(writerIndex).toBeGreaterThan(-1)
    expect(writerIndex).toBeLessThan(helperEnd)
    expect(xidIndex).toBeGreaterThan(helperStart)
    expect(xidIndex).toBeLessThan(writerIndex)
    expect(generatedStatementStart).toBeGreaterThan(-1)
    expect(generatedWriterStatements).toContain('arena.fixture_write_rank_generation_64k_batch(%s)')
    expect(generatedWriterStatements).toMatch(/ORDER BY[\s\S]*batch_index/i)
    expect(generatedWriterStatements).not.toMatch(/\b(?:BEGIN|START\s+TRANSACTION|COMMIT)\b/i)
  })

  it('proves 64 distinct writer XIDs against every durable artifact xmin', () => {
    expect(capacityFixtureCode).toContain('pg_current_xact_id()')
    expect(capacityFixtureCode).toMatch(/count\s*\(\s*DISTINCT\s+[^)]*xid[^)]*\)/i)
    expect(capacityFixtureCode).toMatch(
      /64 (?:distinct |independent )(?:writer |benchmark |batch )?transaction(?: records| IDs| XIDs)[^']*drifted/i
    )
    expect(capacityFixtureCode).toMatch(/\bxmin\b/i)
    expect(occurrenceCount(capacityFixtureCode, /\bxmin\b/i)).toBeGreaterThanOrEqual(4)

    for (const relation of [
      'arena.leaderboard_rank_generation_batch_receipts',
      'public.leaderboard_ranks',
      'arena.leaderboard_rank_generation_source_fence_receipts',
      'arena.leaderboard_rank_generation_manifest_bindings',
    ]) {
      expect(capacityFixtureCode).toContain(relation)
      expectTermsNearEachOther(capacityFixtureCode, relation, 'xmin')
    }
    expectTermsNearEachOther(capacityFixtureCode, 'xmin', 'xid', 3600)
  })

  it('proves the full manifest identity and exact 64 by 1000 immutable plan', () => {
    for (const manifestKey of ['inputs', 'outputs']) {
      expect(capacityFixtureCode).toMatch(
        new RegExp(
          `jsonb_array_length\\([^)]*['\"]${manifestKey}['\"][^)]*\\)[\\s\\S]{0,500}64000`,
          'i'
        )
      )
    }
    expect(capacityFixtureCode).toContain('jsonb_path_query_array')
    expect(capacityFixtureCode).toContain('totalScore > 0')
    expectTermsNearEachOther(capacityFixtureCode, 'jsonb_path_query_array', '64000', 800)
    expect(capacityFixtureCode).toContain('COLLATE pg_catalog."C"')
    expect(capacityFixtureCode).toContain('source_trader_id')
    expect(capacityFixtureCode).toContain('capacity canonical identity C-order drifted')
    expect(capacityFixtureCode).toContain(
      'manifest input/output/eligibility identity order drifted'
    )

    expect(capacityFixtureCode).toMatch(/batch_index[\s\S]{0,600}(?:0[\s\S]{0,80}63|64)/i)
    expect(capacityFixtureCode).toMatch(
      /(?:cardinality|array_length)\s*\(\s*[^)]*batch_sha256_plan[^)]*\)[\s\S]{0,400}64/i
    )
    expect(capacityFixtureCode).toMatch(
      /count\s*\(\s*DISTINCT\s+[^)]*batch_sha256[^)]*\)[\s\S]{0,500}64/i
    )
    expect(capacityFixtureCode).toMatch(/cardinality\s*\(\s*batch\.rows\s*\)\s*<>\s*1000/i)
    expect(capacityFixtureCode).toMatch(/result->>'row_count'\)::integer\s*<>\s*1000/i)
  })

  it('proves source topology, fence continuity, exact cohort, and rank prefix', () => {
    expect(capacityFixtureCode).toContain('arena.leaderboard_rank_generation_source_fence_receipts')
    expectTermsNearEachOther(
      capacityFixtureCode,
      'leaderboard_rank_generation_source_fence_receipts',
      '160',
      1800
    )
    expect(capacityFixtureCode).toMatch(/v_two_source_batches\s*<>\s*32/i)
    expect(capacityFixtureCode).toMatch(/v_three_source_batches\s*<>\s*32/i)
    expect(capacityFixtureCode).toMatch(/v_source_touches\s*<>\s*160/i)
    expect(capacityFixtureCode).toContain('mutation_seq_before')
    expect(capacityFixtureCode).toContain('mutation_seq_after')
    expect(capacityFixtureCode).toMatch(
      /(?:\w+\.)?mutation_seq_after\s*-\s*(?:\w+\.)?mutation_seq_before[\s\S]{0,300}1/i
    )
    expect(capacityFixtureCode).toMatch(/row_number\s*\(\s*\)\s*OVER[\s\S]{0,500}touch_ordinal/i)
    expect(capacityFixtureCode).toMatch(
      /mutation_seq_before\s+IS DISTINCT FROM[\s\S]{0,300}v_base_fence\s*\+\s*touched\.touch_ordinal\s*-\s*1/i
    )

    expect(capacityFixtureCode).toContain('rank_publication_id')
    expect(capacityFixtureCode).toContain('score_cohort_id')
    expectTermsNearEachOther(
      capacityFixtureCode,
      'row_number() OVER',
      `input_value->>'source' COLLATE pg_catalog."C"`,
      800
    )
    expectTermsNearEachOther(
      capacityFixtureCode,
      `input_value->>'source' COLLATE pg_catalog."C"`,
      `input_value->>'source_trader_id'`,
      800
    )
    expect(capacityFixtureCode).toContain('batch receipt count, prefix, or XID binding drifted')
    expect(capacityFixtureCode).toContain(
      'exact 64000-row cohort or rank tuple XID binding drifted'
    )
  })

  it('enforces the 300 second lease budget and emits durable size evidence', () => {
    expect(capacityFixtureCode).toContain('public.claim_leaderboard_rank_generation')
    expectTermsNearEachOther(
      capacityFixtureCode,
      'public.claim_leaderboard_rank_generation',
      '300',
      1600
    )
    expect(capacityFixtureCode).toContain('pg_catalog.clock_timestamp()')
    expect(capacityFixtureCode).toMatch(/elapsed[^\n;]{0,160}(?:>|>=)\s*120/i)
    expect(capacityFixtureCode).toMatch(/remaining[^\n;]{0,160}(?:<|<=)\s*180/i)

    for (const setting of ['fsync', 'synchronous_commit', 'full_page_writes']) {
      expect(capacityFixtureCode).toContain(`pg_catalog.current_setting('${setting}')`)
      expectTermsNearEachOther(capacityFixtureCode, `current_setting('${setting}')`, 'on', 500)
    }
    expect(capacityFixtureCode).toContain('pg_catalog.pg_current_wal_insert_lsn()')
    expect(capacityFixtureCode).toContain('pg_catalog.pg_wal_lsn_diff(')
    expect(capacityFixtureCode).toMatch(/pg_catalog\.pg_(?:total_)?relation_size\(/)
    expect(capacityFixtureCode).toContain('wal_bytes')
    expect(capacityFixtureCode).toContain('manifest_relation_bytes')
    expect(capacityFixtureCode).toContain('rank_relation_bytes')
    expect(capacityFixtureCode).toMatch(/v_wal_bytes\s*<\s*1048576/i)
    expect(capacityFixtureCode).toMatch(/manifest_relation_bytes\s*<\s*4194304/i)
    expect(capacityFixtureCode).toMatch(/rank_relation_bytes\s*<\s*16777216/i)
  })
})
