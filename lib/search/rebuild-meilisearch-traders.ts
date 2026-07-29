import { createHash, randomUUID } from 'node:crypto'
import type { getSupabaseAdmin } from '@/lib/supabase/server'
import { EXCHANGE_CONFIG } from '@/lib/constants/exchanges'
import {
  type LeaderboardPublicationSeason,
  LEADERBOARD_PUBLICATION_PROOFS_MAX_TRADERS,
  type SealedLeaderboardPublicationProofSet,
} from '@/lib/rankings/read-publication-proofs'
import {
  readSealedRankingAuthorityGeneration,
  SealedRankingGenerationChangedError,
} from '@/lib/rankings/read-sealed-ranking-generation'
import {
  assertMeilisearchReconciliationMatch,
  assertMeilisearchTaskSucceeded,
  buildMeilisearchCompoundId,
  buildMeilisearchReconciliationEvidence,
  MEILISEARCH_REBUILD_SEASONS,
  meilisearchTaskUid,
  sortUniqueMeilisearchDocuments,
  type MeilisearchDocumentIdentity,
  type MeilisearchRebuildSeason,
  type MeilisearchReconciliationEvidence,
} from '@/lib/search/meilisearch-authoritative-rebuild'

const LIVE_INDEX_UID = 'traders'
const DATABASE_PAGE_SIZE = 1_000
const MEILI_DOCUMENT_PAGE_SIZE = 1_000
const MEILI_UPLOAD_BATCH_SIZE = 5_000
const MEILI_REQUEST_TIMEOUT_MS = 30_000
const MEILI_TASK_POLL_MS = 100
const CLEANUP_BUDGET_MS = 10_000
const INDEX_UID_PATTERN = /^[A-Za-z0-9_-]+$/
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/
const REQUIRED_FILTERABLE_ATTRIBUTES = [
  'platform',
  'trader_type',
  'arena_score',
  'roi',
  'rank',
  'season_id',
] as const
const RANK_SELECT = [
  'source',
  'source_trader_id',
  'handle',
  'avatar_url',
  'season_id',
  'rank_publication_id',
  'roi',
  'pnl',
  'arena_score',
  'win_rate',
  'max_drawdown',
  'followers',
  'rank',
  'trader_type',
  'computed_at',
].join(',')

type RankingDatabaseClient = Pick<ReturnType<typeof getSupabaseAdmin>, 'from' | 'rpc'>

interface MeiliTransport {
  readonly baseUrl: string
  readonly adminKey: string
  readonly fetchImpl: typeof fetch
  readonly deadlineMs: number
  readonly sleep: (milliseconds: number) => Promise<void>
}

interface MeiliResponse {
  readonly status: number
  readonly payload: unknown
}

interface SeasonSnapshot {
  readonly season: MeilisearchRebuildSeason
  readonly authorityPublicationIdentity: string
  readonly documents: readonly MeilisearchTraderDocument[]
}

export interface MeilisearchTraderDocument extends MeilisearchDocumentIdentity {
  readonly handle: string
  readonly platform: string
  readonly platform_name: string
  readonly roi: number
  readonly pnl: number
  readonly arena_score: number
  readonly win_rate: number | null
  readonly max_drawdown: number | null
  readonly followers: number | null
  readonly rank: number
  readonly trader_type: string | null
  readonly avatar_url: string | null
  readonly updated_at: string
}

export interface RebuildMeilisearchTradersInput {
  readonly supabase: RankingDatabaseClient
  readonly meiliUrl: string
  readonly meiliAdminKey: string
  readonly fetchImpl?: typeof fetch
  readonly timeBudgetMs?: number
  readonly candidateUid?: string
  readonly sleep?: (milliseconds: number) => Promise<void>
}

export interface RebuildMeilisearchTradersResult {
  readonly mode: 'authoritative'
  readonly candidate_uid: string
  readonly task_count: number
  readonly evidence: MeilisearchReconciliationEvidence
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requireMeiliBaseUrl(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new TypeError('Meilisearch URL is invalid')
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new TypeError('Meilisearch URL is invalid')
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new TypeError('Meilisearch URL is invalid')
  }
  return parsed.href.replace(/\/+$/, '')
}

function requireAdminKey(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 32_768 ||
    value.trim() !== value ||
    /[\r\n]/.test(value)
  ) {
    throw new TypeError('Meilisearch admin key is invalid')
  }
  return value
}

function requireTimeBudget(value: number | undefined): number {
  const budget = value ?? 90_000
  if (!Number.isSafeInteger(budget) || budget < 1_000 || budget > 110_000) {
    throw new TypeError('Meilisearch rebuild time budget is invalid')
  }
  return budget
}

function requireCandidateUid(value: string | undefined): string {
  const uid = value ?? `traders_build_${Date.now()}_${randomUUID().replace(/-/g, '')}`
  if (
    uid === LIVE_INDEX_UID ||
    uid.length === 0 ||
    uid.length > 400 ||
    !INDEX_UID_PATTERN.test(uid)
  ) {
    throw new TypeError('Meilisearch candidate index UID is invalid')
  }
  return uid
}

function ensureBeforeDeadline(deadlineMs: number, operation: string): void {
  if (Date.now() >= deadlineMs) {
    throw new Error(`Meilisearch authoritative rebuild exceeded its deadline before ${operation}`)
  }
}

async function meiliJson(
  transport: MeiliTransport,
  path: string,
  method: string,
  body: unknown = undefined,
  acceptedStatuses: readonly number[] = [200, 201, 202]
): Promise<MeiliResponse> {
  ensureBeforeDeadline(transport.deadlineMs, `${method} ${path}`)
  const remainingMs = transport.deadlineMs - Date.now()
  const response = await transport.fetchImpl(`${transport.baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${transport.adminKey}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(Math.max(1, Math.min(MEILI_REQUEST_TIMEOUT_MS, remainingMs))),
  })
  if (!acceptedStatuses.includes(response.status)) {
    throw new Error(`Meilisearch ${method} ${path} failed with status ${response.status}`)
  }

  const raw = await response.text()
  if (raw.length === 0) return { status: response.status, payload: null }
  try {
    return { status: response.status, payload: JSON.parse(raw) }
  } catch {
    throw new Error(`Meilisearch ${method} ${path} returned invalid JSON`)
  }
}

async function waitForTask(transport: MeiliTransport, enqueueResponse: unknown): Promise<number> {
  const expectedTaskUid = meilisearchTaskUid(enqueueResponse)
  for (;;) {
    ensureBeforeDeadline(transport.deadlineMs, `task ${expectedTaskUid} acknowledgement`)
    const { payload } = await meiliJson(
      transport,
      `/tasks/${expectedTaskUid}`,
      'GET',
      undefined,
      [200]
    )
    const taskUid = meilisearchTaskUid(payload)
    if (taskUid !== expectedTaskUid) {
      throw new Error(
        `Meilisearch task identifier mismatch: expected ${expectedTaskUid}, got ${taskUid}`
      )
    }
    const status = isRecord(payload) ? payload.status : undefined
    if (status === 'enqueued' || status === 'processing') {
      await transport.sleep(MEILI_TASK_POLL_MS)
      continue
    }
    assertMeilisearchTaskSucceeded(payload, expectedTaskUid)
    return expectedTaskUid
  }
}

async function enqueueAndWait(
  transport: MeiliTransport,
  path: string,
  method: string,
  body: unknown = undefined
): Promise<number> {
  const { payload } = await meiliJson(transport, path, method, body, [200, 201, 202])
  return waitForTask(transport, payload)
}

function requireString(value: unknown, field: string, allowEmpty = false): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    value.length > 2_048 ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw new TypeError(`Meilisearch source row has invalid ${field}`)
  }
  return value
}

function requireFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`Meilisearch source row has invalid ${field}`)
  }
  return value
}

function optionalFiniteNumber(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number
): number | null {
  if (value === null) return null
  const number = requireFiniteNumber(value, field)
  if (number < minimum || number > maximum) {
    throw new TypeError(`Meilisearch source row has invalid ${field}`)
  }
  return number
}

function optionalString(value: unknown, field: string): string | null {
  if (value === null || value === '') return null
  return requireString(value, field, false)
}

function parseTraderDocument(
  row: Record<string, unknown>,
  season: LeaderboardPublicationSeason,
  publication: SealedLeaderboardPublicationProofSet,
  authoritySources: ReadonlySet<string>
): MeilisearchTraderDocument {
  const source = requireString(row.source, 'source')
  const sourceTraderId = requireString(row.source_trader_id, 'source_trader_id')
  if (
    row.season_id !== season ||
    row.rank_publication_id !== publication.scoreCohortId ||
    !authoritySources.has(source)
  ) {
    throw new Error('Meilisearch source row escaped its sealed publication')
  }
  const rawHandle = row.handle
  const handle =
    rawHandle === null || rawHandle === ''
      ? sourceTraderId
      : requireString(rawHandle, 'handle', false)
  const arenaScore = requireFiniteNumber(row.arena_score, 'arena_score')
  const roi = requireFiniteNumber(row.roi, 'roi')
  const pnl = requireFiniteNumber(row.pnl, 'pnl')
  const rank = requireFiniteNumber(row.rank, 'rank')
  if (
    arenaScore <= 0 ||
    arenaScore > 100 ||
    roi < -10_000 ||
    roi > 10_000 ||
    pnl < -100_000_000 ||
    pnl > 1_000_000_000 ||
    !Number.isSafeInteger(rank) ||
    rank <= 0 ||
    rank > LEADERBOARD_PUBLICATION_PROOFS_MAX_TRADERS
  ) {
    throw new TypeError('Meilisearch source row has invalid published score or rank')
  }
  const computedAt = requireString(row.computed_at, 'computed_at')
  if (!Number.isFinite(Date.parse(computedAt))) {
    throw new TypeError('Meilisearch source row has invalid computed_at')
  }

  const identity = { source, source_trader_id: sourceTraderId, season_id: season }
  return Object.freeze({
    id: buildMeilisearchCompoundId(identity),
    handle,
    platform: source,
    platform_name: EXCHANGE_CONFIG[source as keyof typeof EXCHANGE_CONFIG]?.name || source,
    season_id: season,
    roi,
    pnl,
    arena_score: arenaScore,
    win_rate: requireBoundedNumber(row.win_rate, 'win_rate', 0, 100, true),
    max_drawdown: requireBoundedNumber(row.max_drawdown, 'max_drawdown', 0, 100, false),
    followers: optionalFiniteNumber(row.followers, 'followers', 0, Number.MAX_SAFE_INTEGER),
    rank,
    trader_type: optionalString(row.trader_type, 'trader_type'),
    avatar_url: optionalString(row.avatar_url, 'avatar_url'),
    updated_at: computedAt,
  })
}

function requireBoundedNumber(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
  inclusiveMaximum: boolean
): number {
  const number = requireFiniteNumber(value, field)
  if (number < minimum || (inclusiveMaximum ? number > maximum : number >= maximum)) {
    throw new TypeError(`Meilisearch source row has invalid ${field}`)
  }
  return number
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function hashPostgresJsonbStringArray(values: readonly string[]): string {
  const jsonbText = `[${values.map((value) => JSON.stringify(value)).join(', ')}]`
  return createHash('sha256').update(jsonbText, 'utf8').digest('hex')
}

function assertIdentitiesMatchPublication(
  identitiesBySource: ReadonlyMap<string, readonly string[]>,
  publication: SealedLeaderboardPublicationProofSet
): void {
  for (const proof of publication.proofs) {
    const identities = identitiesBySource.get(proof.source)
    if (!identities || identities.length !== proof.published_rank_count) {
      throw new Error(`${proof.source} Meilisearch count does not match its publication proof`)
    }
    const sorted = [...identities].sort(compareUtf8)
    if (hashPostgresJsonbStringArray(sorted) !== proof.published_identity_sha256) {
      throw new Error(`${proof.source} Meilisearch identities do not match its publication proof`)
    }
  }
}

function publicationRankCount(publication: SealedLeaderboardPublicationProofSet): number {
  const count = publication.proofs.reduce((total, proof) => total + proof.published_rank_count, 0)
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new Error(`sealed ${publication.season} leaderboard is empty or exceeds capacity`)
  }
  return count
}

async function readDatabasePage(
  supabase: RankingDatabaseClient,
  season: MeilisearchRebuildSeason,
  sources: readonly string[],
  scoreCohortId: string,
  offset: number,
  limit: number,
  deadlineMs: number
): Promise<Record<string, unknown>[]> {
  ensureBeforeDeadline(deadlineMs, `${season} database page`)
  const remainingMs = Math.max(1, deadlineMs - Date.now())
  const result = await supabase
    .from('leaderboard_ranks')
    .select(RANK_SELECT)
    .eq('season_id', season)
    .in('source', sources)
    .filter('rank_publication_id', 'eq', scoreCohortId)
    .order('source', { ascending: true })
    .order('source_trader_id', { ascending: true })
    .abortSignal(AbortSignal.timeout(remainingMs))
    .range(offset, offset + limit - 1)
  if (result.error) {
    throw new Error(`sealed ${season} leaderboard page failed: ${result.error.message}`)
  }
  const payload: unknown = result.data
  if (!Array.isArray(payload)) {
    throw new Error(`sealed ${season} leaderboard page returned an ambiguous payload`)
  }
  if (payload.length > limit) {
    throw new Error(`sealed ${season} leaderboard page exceeded its requested bound`)
  }
  return payload.map((row) => {
    if (!isRecord(row)) {
      throw new Error(`sealed ${season} leaderboard page returned an invalid row`)
    }
    return row
  })
}

function proofOptions(deadlineMs: number): { signal: AbortSignal; timeoutMs: number } {
  ensureBeforeDeadline(deadlineMs, 'publication proof')
  const remainingMs = Math.max(1, deadlineMs - Date.now())
  return {
    signal: AbortSignal.timeout(remainingMs),
    timeoutMs: Math.min(MEILI_REQUEST_TIMEOUT_MS, remainingMs),
  }
}

async function readSeasonSnapshot(
  supabase: RankingDatabaseClient,
  season: MeilisearchRebuildSeason,
  deadlineMs: number
): Promise<SeasonSnapshot> {
  const sealed = await readSealedRankingAuthorityGeneration(
    supabase,
    season,
    async (publication) => {
      const expectedCount = publicationRankCount(publication)
      const sources = publication.proofs.map((proof) => proof.source)
      const authoritySources = new Set(sources)
      const documents: MeilisearchTraderDocument[] = []
      const identitiesBySource = new Map(sources.map((source) => [source, [] as string[]] as const))

      while (documents.length < expectedCount) {
        ensureBeforeDeadline(deadlineMs, `${season} database pagination`)
        const requested = Math.min(DATABASE_PAGE_SIZE, expectedCount - documents.length)
        const rows = await readDatabasePage(
          supabase,
          season,
          sources,
          publication.scoreCohortId,
          documents.length,
          requested,
          deadlineMs
        )
        if (rows.length === 0) {
          throw new Error(
            `sealed ${season} leaderboard ended at ${documents.length} of ${expectedCount} rows`
          )
        }
        for (const row of rows) {
          const document = parseTraderDocument(row, season, publication, authoritySources)
          const identities = identitiesBySource.get(document.platform)
          if (!identities) {
            throw new Error('Meilisearch source row escaped its publication source set')
          }
          identities.push(requireString(row.source_trader_id, 'source_trader_id'))
          documents.push(document)
        }
      }

      const completenessProbe = await readDatabasePage(
        supabase,
        season,
        sources,
        publication.scoreCohortId,
        expectedCount,
        1,
        deadlineMs
      )
      if (completenessProbe.length !== 0) {
        throw new Error(`sealed ${season} leaderboard exceeded its proof count`)
      }
      if (documents.length !== expectedCount) {
        throw new Error(`sealed ${season} leaderboard count does not match its proof`)
      }
      assertIdentitiesMatchPublication(identitiesBySource, publication)
      return Object.freeze(documents)
    },
    proofOptions(deadlineMs)
  )

  return Object.freeze({
    season,
    authorityPublicationIdentity: sealed.authorityPublicationIdentity,
    documents: sealed.value,
  })
}

async function ensureLiveIndex(transport: MeiliTransport): Promise<number> {
  const current = await meiliJson(
    transport,
    `/indexes/${LIVE_INDEX_UID}`,
    'GET',
    undefined,
    [200, 404]
  )
  if (current.status === 404) {
    await enqueueAndWait(transport, '/indexes', 'POST', {
      uid: LIVE_INDEX_UID,
      primaryKey: 'id',
    })
    return 1
  }
  if (
    !isRecord(current.payload) ||
    current.payload.uid !== LIVE_INDEX_UID ||
    current.payload.primaryKey !== 'id'
  ) {
    throw new Error('Meilisearch live traders index has an invalid identity')
  }
  return 0
}

async function readCandidateEvidence(
  transport: MeiliTransport,
  candidateUid: string
): Promise<MeilisearchReconciliationEvidence> {
  const documents: MeilisearchDocumentIdentity[] = []
  let expectedTotal: number | undefined

  for (;;) {
    const params = new URLSearchParams({
      offset: String(documents.length),
      limit: String(MEILI_DOCUMENT_PAGE_SIZE),
      fields: 'id,season_id',
    })
    const { payload } = await meiliJson(
      transport,
      `/indexes/${encodeURIComponent(candidateUid)}/documents?${params.toString()}`,
      'GET',
      undefined,
      [200]
    )
    if (!isRecord(payload) || !Array.isArray(payload.results)) {
      throw new Error('Meilisearch candidate enumeration returned an invalid payload')
    }
    const offset = payload.offset
    const total = payload.total
    if (
      !Number.isSafeInteger(offset) ||
      offset !== documents.length ||
      !Number.isSafeInteger(total) ||
      Number(total) <= 0 ||
      Number(total) > LEADERBOARD_PUBLICATION_PROOFS_MAX_TRADERS * 3
    ) {
      throw new Error('Meilisearch candidate enumeration returned invalid pagination')
    }
    if (expectedTotal !== undefined && total !== expectedTotal) {
      throw new Error('Meilisearch candidate total changed during reconciliation')
    }
    expectedTotal ??= Number(total)
    if (payload.results.length === 0 && documents.length < expectedTotal) {
      throw new Error('Meilisearch candidate enumeration ended before its total')
    }
    if (payload.results.length > MEILI_DOCUMENT_PAGE_SIZE) {
      throw new Error('Meilisearch candidate enumeration exceeded its page bound')
    }
    for (const row of payload.results) {
      if (!isRecord(row) || typeof row.id !== 'string' || typeof row.season_id !== 'string') {
        throw new Error('Meilisearch candidate enumeration returned an invalid document')
      }
      documents.push({
        id: row.id,
        season_id: row.season_id as MeilisearchRebuildSeason,
      })
    }
    if (documents.length >= expectedTotal) break
  }

  if (documents.length !== expectedTotal) {
    throw new Error('Meilisearch candidate enumeration did not equal its total')
  }
  return buildMeilisearchReconciliationEvidence(documents)
}

async function assertGenerationsUnchanged(
  supabase: RankingDatabaseClient,
  snapshots: readonly SeasonSnapshot[],
  deadlineMs: number
): Promise<void> {
  await Promise.all(
    snapshots.map(async (snapshot) => {
      const current = await readSealedRankingAuthorityGeneration(
        supabase,
        snapshot.season,
        async () => null,
        proofOptions(deadlineMs)
      )
      if (current.authorityPublicationIdentity !== snapshot.authorityPublicationIdentity) {
        throw new SealedRankingGenerationChangedError()
      }
    })
  )
}

async function safeDeleteCandidate(transport: MeiliTransport, candidateUid: string): Promise<void> {
  const cleanupTransport = {
    ...transport,
    deadlineMs: Math.max(transport.deadlineMs, Date.now() + CLEANUP_BUDGET_MS),
  }
  try {
    const response = await meiliJson(
      cleanupTransport,
      `/indexes/${encodeURIComponent(candidateUid)}`,
      'DELETE',
      undefined,
      [200, 202, 404]
    )
    if (response.status !== 404) {
      await waitForTask(cleanupTransport, response.payload)
    }
  } catch {
    // Cleanup must never conceal the publication failure that kept the live
    // index unchanged. A unique UID prevents a leftover candidate being reused.
  }
}

/**
 * Build, reconcile, and atomically swap a complete sealed traders index.
 *
 * No mutation reaches the live index until the database generations are
 * double-proved, every candidate write task has succeeded, the candidate
 * identity set exactly matches the frozen source, and the generations are
 * revalidated immediately before the swap.
 */
export async function rebuildMeilisearchTraders(
  input: RebuildMeilisearchTradersInput
): Promise<RebuildMeilisearchTradersResult> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Meilisearch rebuild input is invalid')
  }
  const timeBudgetMs = requireTimeBudget(input.timeBudgetMs)
  const candidateUid = requireCandidateUid(input.candidateUid)
  const transport: MeiliTransport = {
    baseUrl: requireMeiliBaseUrl(input.meiliUrl),
    adminKey: requireAdminKey(input.meiliAdminKey),
    fetchImpl: input.fetchImpl ?? fetch,
    deadlineMs: Date.now() + timeBudgetMs,
    sleep:
      input.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => {
          setTimeout(resolve, milliseconds)
        })),
  }
  if (typeof transport.fetchImpl !== 'function' || typeof transport.sleep !== 'function') {
    throw new TypeError('Meilisearch rebuild transport is invalid')
  }

  const snapshots: SeasonSnapshot[] = []
  for (const season of MEILISEARCH_REBUILD_SEASONS) {
    snapshots.push(await readSeasonSnapshot(input.supabase, season, transport.deadlineMs))
  }
  const documents = sortUniqueMeilisearchDocuments(
    snapshots.flatMap((snapshot) => snapshot.documents)
  )
  const expectedEvidence = buildMeilisearchReconciliationEvidence(documents)

  let candidateCreated = false
  let taskCount = await ensureLiveIndex(transport)
  try {
    const candidateCreation = await meiliJson(
      transport,
      '/indexes',
      'POST',
      {
        uid: candidateUid,
        primaryKey: 'id',
      },
      [200, 201, 202]
    )
    // Once Meilisearch accepts creation, a transport failure while polling can
    // still leave an index behind. Mark it for cleanup before awaiting ACK.
    candidateCreated = true
    await waitForTask(transport, candidateCreation.payload)
    taskCount += 1

    await enqueueAndWait(
      transport,
      `/indexes/${encodeURIComponent(candidateUid)}/settings`,
      'PUT',
      { filterableAttributes: REQUIRED_FILTERABLE_ATTRIBUTES }
    )
    taskCount += 1

    for (let offset = 0; offset < documents.length; offset += MEILI_UPLOAD_BATCH_SIZE) {
      await enqueueAndWait(
        transport,
        `/indexes/${encodeURIComponent(candidateUid)}/documents`,
        'POST',
        documents.slice(offset, offset + MEILI_UPLOAD_BATCH_SIZE)
      )
      taskCount += 1
    }

    const observedEvidence = await readCandidateEvidence(transport, candidateUid)
    assertMeilisearchReconciliationMatch(expectedEvidence, observedEvidence)
    await assertGenerationsUnchanged(input.supabase, snapshots, transport.deadlineMs)

    await enqueueAndWait(transport, '/swap-indexes', 'POST', [
      { indexes: [LIVE_INDEX_UID, candidateUid] },
    ])
    taskCount += 1

    await enqueueAndWait(transport, `/indexes/${encodeURIComponent(candidateUid)}`, 'DELETE')
    candidateCreated = false
    taskCount += 1

    return Object.freeze({
      mode: 'authoritative',
      candidate_uid: candidateUid,
      task_count: taskCount,
      evidence: expectedEvidence,
    })
  } catch (error) {
    if (candidateCreated) await safeDeleteCandidate(transport, candidateUid)
    throw error
  }
}
