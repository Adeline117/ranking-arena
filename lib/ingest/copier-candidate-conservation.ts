import { z } from 'zod'

import { BINANCE_HISTORY_PAGE_ENVELOPE_CONTRACT } from './adapters/binance/history-contract'
import { BITGET_HISTORY_PAGE_ENVELOPE_CONTRACT } from './adapters/bitget/history-terminal'
import type { ParsedHistoryRow, ProductType, RawPage, SourceRow } from './core/types'
import {
  STRICT_CANONICAL_JSON_CONTRACT,
  strictCanonicalJson,
  strictCanonicalSha256,
} from './strict-canonical-json'

export const COPIER_CANDIDATE_LEDGER_CONTRACT = 'arena.ingest.copier-candidate-ledger@1' as const
export const COPIER_CANDIDATE_MULTISET_CONTRACT =
  'arena.ingest.copier-candidate-multiset@1' as const
export const COPIER_PARSER_CONSERVATION_CONTRACT =
  'arena.ingest.copier-parser-conservation@1' as const
export const COPIER_CANDIDATE_REPLAY_BINDING_CONTRACT =
  'arena.ingest.copier-candidate-replay-binding@1' as const

export const COPIER_CANDIDATE_ADAPTER_SLUGS = Object.freeze([
  'binance',
  'bingx',
  'bitget',
  'bitget_bots',
  'bitunix',
  'blofin',
  'btcc',
  'bybit_copytrade',
  'coinex',
  'gate',
  'kucoin',
  'lbank',
  'mexc',
  'okx',
  'toobit',
  'xt',
] as const)

export type CopierCandidateAdapterSlug = (typeof COPIER_CANDIDATE_ADAPTER_SLUGS)[number]
export type CopierCandidateLocatorContract =
  `arena.ingest.copier-candidate-locator.${string}@${number}`

export interface CopierCandidateReplayBinding {
  readonly contract: typeof COPIER_CANDIDATE_REPLAY_BINDING_CONTRACT
  readonly serialization_contract: typeof STRICT_CANONICAL_JSON_CONTRACT
  readonly adapter_slug: CopierCandidateAdapterSlug
  readonly product_type: ProductType
  readonly candidate_locator_contract: CopierCandidateLocatorContract
}

export interface CopierCandidateReplaySourceCoordinates {
  readonly id: number
  readonly slug: string
}

type Dict = Record<string, unknown>

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/)
const positiveSafeIntegerSchema = z
  .number()
  .refine((value) => Number.isSafeInteger(value) && value > 0, 'must be a positive safe integer')
const nonnegativeSafeIntegerSchema = z
  .number()
  .refine(
    (value) => Number.isSafeInteger(value) && value >= 0,
    'must be a nonnegative safe integer'
  )
const sourceSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9_]{0,127}$/)
const exchangeTraderIdSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value.trim() === value, 'must not have surrounding whitespace')
const locatorContractSchema = z
  .string()
  .regex(/^arena\.ingest\.copier-candidate-locator\.[a-z0-9_.]+@[1-9][0-9]*$/)
  .transform((value): CopierCandidateLocatorContract => value as CopierCandidateLocatorContract)
const productTypeSchema = z.enum(['spot', 'futures', 'cfd', 'onchain'])

const replayBindingSchema = z
  .object({
    contract: z.literal(COPIER_CANDIDATE_REPLAY_BINDING_CONTRACT),
    serialization_contract: z.literal(STRICT_CANONICAL_JSON_CONTRACT),
    adapter_slug: z.enum(COPIER_CANDIDATE_ADAPTER_SLUGS),
    product_type: productTypeSchema,
    candidate_locator_contract: locatorContractSchema,
  })
  .strict()

const replaySourceCoordinatesSchema = z
  .object({
    id: positiveSafeIntegerSchema,
    slug: sourceSlugSchema,
  })
  .strict()

const occurrenceSchema = z
  .object({
    candidate_ordinal: positiveSafeIntegerSchema,
    raw_candidate_sha256: sha256Schema,
  })
  .strict()

const pageSchema = z
  .object({
    page_ordinal: positiveSafeIntegerSchema,
    source_page_index: positiveSafeIntegerSchema,
    locator_contract: locatorContractSchema,
    candidate_count: nonnegativeSafeIntegerSchema,
    occurrences: z.array(occurrenceSchema),
  })
  .strict()

const sourceSchema = z
  .object({
    id: positiveSafeIntegerSchema,
    slug: sourceSlugSchema,
    adapter_slug: z.enum(COPIER_CANDIDATE_ADAPTER_SLUGS),
  })
  .strict()

export const copierCandidateLedgerSchema = z
  .object({
    contract: z.literal(COPIER_CANDIDATE_LEDGER_CONTRACT),
    serialization_contract: z.literal(STRICT_CANONICAL_JSON_CONTRACT),
    multiset_contract: z.literal(COPIER_CANDIDATE_MULTISET_CONTRACT),
    source: sourceSchema,
    exchange_trader_id: exchangeTraderIdSchema,
    page_count: positiveSafeIntegerSchema,
    observed_candidate_count: nonnegativeSafeIntegerSchema,
    candidate_multiset_sha256: sha256Schema,
    pages: z.array(pageSchema).min(1).max(100000),
  })
  .strict()
  .superRefine((ledger, ctx) => {
    if (ledger.page_count !== ledger.pages.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['page_count'],
        message: 'page count must equal the page ledger length',
      })
    }

    const hashes: string[] = []
    for (const [pageIndex, page] of ledger.pages.entries()) {
      if (page.page_ordinal !== pageIndex + 1 || page.source_page_index !== pageIndex + 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['pages', pageIndex],
          message: 'copier snapshot pages must be contiguous and ordered',
        })
      }
      if (page.candidate_count !== page.occurrences.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['pages', pageIndex, 'candidate_count'],
          message: 'candidate count must equal occurrence count',
        })
      }
      page.occurrences.forEach((occurrence, occurrenceIndex) => {
        if (occurrence.candidate_ordinal !== occurrenceIndex + 1) {
          ctx.addIssue({
            code: 'custom',
            path: ['pages', pageIndex, 'occurrences', occurrenceIndex, 'candidate_ordinal'],
            message: 'candidate ordinals must be contiguous and ordered',
          })
        }
        hashes.push(occurrence.raw_candidate_sha256)
      })
    }

    if (ledger.observed_candidate_count !== hashes.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['observed_candidate_count'],
        message: 'observed candidate count must equal all occurrences',
      })
    }
    if (candidateMultisetSha256(hashes) !== ledger.candidate_multiset_sha256) {
      ctx.addIssue({
        code: 'custom',
        path: ['candidate_multiset_sha256'],
        message: 'candidate multiset digest does not match occurrences',
      })
    }
  })

export type CopierCandidateLedger = z.infer<typeof copierCandidateLedgerSchema>

const parserOccurrenceSchema = z
  .object({
    row_ordinal: nonnegativeSafeIntegerSchema,
    raw_candidate_sha256: sha256Schema,
  })
  .strict()

export const copierParserConservationProofSchema = z
  .object({
    contract: z.literal(COPIER_PARSER_CONSERVATION_CONTRACT),
    serialization_contract: z.literal(STRICT_CANONICAL_JSON_CONTRACT),
    candidate_ledger_sha256: sha256Schema,
    source: sourceSchema,
    exchange_trader_id: exchangeTraderIdSchema,
    observed_candidate_count: nonnegativeSafeIntegerSchema,
    parsed_row_count: nonnegativeSafeIntegerSchema,
    candidate_multiset_sha256: sha256Schema,
    parsed_raw_multiset_sha256: sha256Schema,
    rows: z.array(parserOccurrenceSchema).max(10000000),
  })
  .strict()
  .superRefine((proof, ctx) => {
    if (
      proof.observed_candidate_count !== proof.parsed_row_count ||
      proof.parsed_row_count !== proof.rows.length
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['parsed_row_count'],
        message: 'candidate, parsed, and row occurrence counts must match',
      })
    }
    proof.rows.forEach((row, index) => {
      if (row.row_ordinal !== index) {
        ctx.addIssue({
          code: 'custom',
          path: ['rows', index, 'row_ordinal'],
          message: 'parser row ordinals must be contiguous and ordered',
        })
      }
    })
    if (
      candidateMultisetSha256(proof.rows.map((row) => row.raw_candidate_sha256)) !==
      proof.parsed_raw_multiset_sha256
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['parsed_raw_multiset_sha256'],
        message: 'parsed RAW multiset digest does not match row occurrences',
      })
    }
    if (proof.candidate_multiset_sha256 !== proof.parsed_raw_multiset_sha256) {
      ctx.addIssue({
        code: 'custom',
        path: ['parsed_raw_multiset_sha256'],
        message: 'parsed RAW multiset does not conserve captured candidates',
      })
    }
  })

export type CopierParserConservationProof = z.infer<typeof copierParserConservationProofSchema>

export interface ExtractCopierCandidateRecordsInput {
  src: SourceRow
  exchangeTraderId: string
  pageIndex: number
  payload: unknown
}

export interface ExtractedCopierCandidateRecords {
  readonly locatorContract: string
  readonly candidates: readonly Readonly<Dict>[]
}

interface CandidateLocator {
  readonly contract: string
  extract(input: {
    binding: CopierCandidateReplayBinding
    exchangeTraderId: string
    pageIndex: number
    payload: Dict
  }): unknown[]
}

function conservationError(detail: string): Error {
  return new Error(`[ingest] copier candidate conservation failed: ${detail}`)
}

function isPlainRecord(value: unknown): value is Dict {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function canonicalClone<T>(value: T, label: string): T {
  try {
    return deepFreeze(JSON.parse(strictCanonicalJson(value)) as T)
  } catch (cause) {
    throw conservationError(
      `${label} is not strict canonical JSON: ${cause instanceof Error ? cause.message : String(cause)}`
    )
  }
}

function canonicalSchemaClone<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const canonical = canonicalClone(value, label)
  const parsed = schema.safeParse(canonical)
  if (!parsed.success) throw conservationError(`${label} violates its contract`)
  return canonicalClone(parsed.data, label)
}

function exactKeys(value: Dict, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  )
}

function recordAt(value: unknown, label: string): Dict {
  if (!isPlainRecord(value)) throw conservationError(`${label} must be an object`)
  return value
}

function arrayAt(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw conservationError(`${label} must be an array`)
  return value
}

function assertSuccess(condition: boolean, adapter: string): void {
  if (!condition) throw conservationError(`${adapter} returned a non-success envelope`)
}

function pathArray(root: Dict, path: readonly string[], label: string): unknown[] {
  let current: unknown = root
  for (const key of path) current = recordAt(current, `${label}.${key}`)[key]
  return arrayAt(current, `${label}.${path.join('.')}`)
}

function locator(
  adapter: CopierCandidateAdapterSlug,
  extract: CandidateLocator['extract']
): CandidateLocator {
  return Object.freeze({
    contract: `arena.ingest.copier-candidate-locator.${adapter}@1`,
    extract,
  })
}

const locators: Readonly<Record<CopierCandidateAdapterSlug, CandidateLocator>> = Object.freeze({
  binance: locator('binance', ({ exchangeTraderId, pageIndex, payload }) => {
    if (
      !exactKeys(payload, ['contract', 'portfolioId', 'request', 'response', 'sort']) ||
      payload.contract !== BINANCE_HISTORY_PAGE_ENVELOPE_CONTRACT ||
      payload.portfolioId !== exchangeTraderId ||
      payload.sort !== null
    ) {
      throw conservationError('binance canonical wrapper is invalid')
    }
    const request = recordAt(payload.request, 'binance.request')
    if (
      !exactKeys(request, ['pageNumber', 'pageSize', 'portfolioId']) ||
      request.pageNumber !== pageIndex ||
      request.pageSize !== 50 ||
      request.portfolioId !== exchangeTraderId
    ) {
      throw conservationError('binance copier request binding is invalid')
    }
    const response = recordAt(payload.response, 'binance.response')
    assertSuccess(response.code === '000000' && response.success === true, 'binance')
    return pathArray(response, ['data', 'list'], 'binance.response')
  }),
  bingx: locator('bingx', ({ payload }) => {
    assertSuccess(payload.code === 0, 'bingx')
    return pathArray(payload, ['data', 'followerDetailsVoList'], 'bingx')
  }),
  bitget: locator('bitget', ({ exchangeTraderId, pageIndex, payload }) => {
    if (
      !exactKeys(payload, ['contract', 'historyTraderIdentity', 'request', 'response']) ||
      payload.contract !== BITGET_HISTORY_PAGE_ENVELOPE_CONTRACT ||
      payload.historyTraderIdentity !== exchangeTraderId
    ) {
      throw conservationError('bitget canonical wrapper is invalid')
    }
    const request = recordAt(payload.request, 'bitget.request')
    if (
      !exactKeys(request, ['pageNo', 'pageSize', 'traderUid']) ||
      request.pageNo !== pageIndex ||
      request.pageSize !== 10 ||
      request.traderUid !== exchangeTraderId
    ) {
      throw conservationError('bitget copier request binding is invalid')
    }
    const response = recordAt(payload.response, 'bitget.response')
    assertSuccess(response.code === '00000' && response.success === true, 'bitget')
    return pathArray(response, ['data', 'rows'], 'bitget.response')
  }),
  bitget_bots: locator('bitget_bots', ({ payload }) => {
    assertSuccess(payload.code === '200', 'bitget_bots')
    return pathArray(payload, ['data', 'followers'], 'bitget_bots')
  }),
  bitunix: locator('bitunix', ({ payload }) => {
    assertSuccess(payload.code === 0 && payload.success === true, 'bitunix')
    return pathArray(payload, ['data', 'records'], 'bitunix')
  }),
  blofin: locator('blofin', ({ payload }) => {
    assertSuccess(payload.code === 200, 'blofin')
    return arrayAt(payload.data, 'blofin.data')
  }),
  btcc: locator('btcc', ({ payload }) => {
    assertSuccess(payload.code === 200, 'btcc')
    return arrayAt(payload.rows, 'btcc.rows')
  }),
  bybit_copytrade: locator('bybit_copytrade', ({ payload }) => {
    assertSuccess(payload.retCode === 0, 'bybit_copytrade')
    return pathArray(payload, ['result', 'data'], 'bybit_copytrade')
  }),
  coinex: locator('coinex', ({ payload }) => {
    assertSuccess(payload.code === 0, 'coinex')
    return pathArray(payload, ['data', 'data'], 'coinex')
  }),
  gate: Object.freeze({
    contract: 'arena.ingest.copier-candidate-locator.gate@1',
    extract: (({ binding, payload }) => {
      if (
        binding.product_type === 'futures' &&
        binding.candidate_locator_contract ===
          'arena.ingest.copier-candidate-locator.gate.futures@1'
      ) {
        assertSuccess(payload.code === 200, 'gate futures')
        return arrayAt(payload.data, 'gate.data')
      }
      if (
        binding.product_type === 'cfd' &&
        binding.candidate_locator_contract === 'arena.ingest.copier-candidate-locator.gate.cfd@1'
      ) {
        assertSuccess(payload.code === 0, 'gate cfd')
        return pathArray(payload, ['data', 'list'], 'gate')
      }
      throw conservationError('gate replay binding must name one internally consistent variant')
    }) satisfies CandidateLocator['extract'],
  }),
  kucoin: locator('kucoin', ({ payload }) => {
    assertSuccess(payload.code === '200' && payload.success === true, 'kucoin')
    return pathArray(payload, ['data', 'items'], 'kucoin')
  }),
  lbank: locator('lbank', ({ payload }) => {
    assertSuccess(payload.code === 200, 'lbank')
    return pathArray(payload, ['data', 'records'], 'lbank')
  }),
  mexc: locator('mexc', ({ payload }) => {
    assertSuccess(payload.code === 0 && payload.success === true, 'mexc')
    return pathArray(payload, ['data', 'content'], 'mexc')
  }),
  okx: locator('okx', ({ payload }) => {
    assertSuccess(payload.code === '0', 'okx')
    const blocks = arrayAt(payload.data, 'okx.data')
    if (blocks.length !== 1) {
      throw conservationError('okx must expose exactly one aggregate block')
    }
    return arrayAt(recordAt(blocks[0], 'okx.data[0]').copyTraders, 'okx.data[0].copyTraders')
  }),
  toobit: locator('toobit', ({ payload }) => {
    assertSuccess(payload.code === 200, 'toobit')
    return arrayAt(payload.data, 'toobit.data')
  }),
  xt: locator('xt', ({ payload }) => {
    assertSuccess(payload.returnCode === 0 && payload.error === null, 'xt')
    return pathArray(payload, ['result', 'items'], 'xt')
  }),
})

function registeredLocator(adapterSlug: string): CandidateLocator {
  if (!Object.prototype.hasOwnProperty.call(locators, adapterSlug)) {
    throw conservationError(`adapter ${adapterSlug} is not registered`)
  }
  const selected = locators[adapterSlug as CopierCandidateAdapterSlug]
  if (!selected) throw conservationError(`adapter ${adapterSlug} is not registered`)
  return selected
}

export function selectCopierCandidateLocatorContract(
  adapterSlug: string,
  productType: ProductType
): CopierCandidateLocatorContract {
  const parsedProductType = productTypeSchema.safeParse(productType)
  if (!parsedProductType.success) throw conservationError('product type is invalid')
  const selected = registeredLocator(adapterSlug)
  if (adapterSlug === 'gate') {
    if (parsedProductType.data === 'futures') {
      return 'arena.ingest.copier-candidate-locator.gate.futures@1'
    }
    if (parsedProductType.data === 'cfd') {
      return 'arena.ingest.copier-candidate-locator.gate.cfd@1'
    }
    throw conservationError('gate product type must be futures or cfd')
  }
  return selected.contract as CopierCandidateLocatorContract
}

function canonicalLiveReplaySource(input: SourceRow): Readonly<{
  id: number
  slug: string
  adapter_slug: string
  product_type: ProductType
  meta: Dict
}> {
  const snapshot = canonicalClone(input, 'source row')
  if (
    !isPlainRecord(snapshot) ||
    !Number.isSafeInteger(snapshot.id) ||
    (snapshot.id as number) <= 0 ||
    !sourceSlugSchema.safeParse(snapshot.slug).success ||
    typeof snapshot.adapter_slug !== 'string' ||
    !productTypeSchema.safeParse(snapshot.product_type).success ||
    !isPlainRecord(snapshot.meta)
  ) {
    throw conservationError('source row is missing candidate replay coordinates')
  }
  return Object.freeze({
    id: snapshot.id as number,
    slug: snapshot.slug as string,
    adapter_slug: snapshot.adapter_slug,
    product_type: snapshot.product_type as ProductType,
    meta: snapshot.meta,
  })
}

function buildReplayBindingFromCanonicalSource(
  src: ReturnType<typeof canonicalLiveReplaySource>
): CopierCandidateReplayBinding {
  const adapterSlug = src.adapter_slug
  const locatorContract = selectCopierCandidateLocatorContract(adapterSlug, src.product_type)
  if (adapterSlug === 'gate' && src.meta.boardKey !== src.product_type) {
    throw conservationError('gate source variant must be explicit and internally consistent')
  }
  return canonicalSchemaClone(
    replayBindingSchema,
    {
      contract: COPIER_CANDIDATE_REPLAY_BINDING_CONTRACT,
      serialization_contract: STRICT_CANONICAL_JSON_CONTRACT,
      adapter_slug: adapterSlug,
      product_type: src.product_type,
      candidate_locator_contract: locatorContract,
    },
    'candidate replay binding'
  )
}

/**
 * Derive the immutable replay identity while the complete live source is
 * available. This identifies candidate extraction only; it is not publication
 * authorization. Callers must separately enforce the current source/surface
 * capability gate before creating trusted evidence.
 */
export function deriveCopierCandidateReplayBinding(src: SourceRow): CopierCandidateReplayBinding {
  return buildReplayBindingFromCanonicalSource(canonicalLiveReplaySource(src))
}

/** Validate an untrusted persisted binding with exact keys and a closed locator registry. */
export function revalidateCopierCandidateReplayBinding(
  value: unknown
): CopierCandidateReplayBinding {
  const binding = canonicalSchemaClone(replayBindingSchema, value, 'candidate replay binding')
  const expected = selectCopierCandidateLocatorContract(binding.adapter_slug, binding.product_type)
  if (binding.candidate_locator_contract !== expected) {
    throw conservationError('candidate replay binding locator does not match its adapter variant')
  }
  return binding
}

function candidateMultisetSha256(hashes: readonly string[]): string {
  return strictCanonicalSha256({
    contract: COPIER_CANDIDATE_MULTISET_CONTRACT,
    candidate_count: hashes.length,
    raw_candidate_sha256: [...hashes].sort(),
  })
}

function canonicalReplaySource(
  input: CopierCandidateReplaySourceCoordinates,
  binding: CopierCandidateReplayBinding
): CopierCandidateLedger['source'] {
  const source = canonicalSchemaClone(
    replaySourceCoordinatesSchema,
    input,
    'candidate replay source coordinates'
  )
  return canonicalSchemaClone(
    sourceSchema,
    { id: source.id, slug: source.slug, adapter_slug: binding.adapter_slug },
    'source coordinates'
  )
}

function extractCopierCandidateRecordsWithBinding(input: {
  binding: CopierCandidateReplayBinding
  exchangeTraderId: string
  pageIndex: number
  payload: unknown
}): ExtractedCopierCandidateRecords {
  if (!Number.isSafeInteger(input.pageIndex) || input.pageIndex <= 0) {
    throw conservationError('source page index must be a positive safe integer')
  }
  const traderIdentity = exchangeTraderIdSchema.safeParse(input.exchangeTraderId)
  if (!traderIdentity.success) throw conservationError('exchange trader id is invalid')
  const adapterSlug = input.binding.adapter_slug
  const selected = registeredLocator(adapterSlug)

  const payload = canonicalClone(input.payload, `${adapterSlug} page payload`)
  if (!isPlainRecord(payload))
    throw conservationError(`${adapterSlug} page payload must be an object`)
  const candidates = selected.extract({
    binding: input.binding,
    exchangeTraderId: traderIdentity.data,
    pageIndex: input.pageIndex,
    payload,
  })
  const normalized = candidates.map((candidate, index) => {
    if (!isPlainRecord(candidate)) {
      throw conservationError(`${adapterSlug} candidate ${index + 1} must be an object`)
    }
    return canonicalClone(candidate, `${adapterSlug} candidate ${index + 1}`)
  })
  return Object.freeze({
    locatorContract: input.binding.candidate_locator_contract,
    candidates: Object.freeze(normalized),
  })
}

export function extractCopierCandidateRecordsFromReplayBinding(input: {
  binding: unknown
  exchangeTraderId: string
  pageIndex: number
  payload: unknown
}): ExtractedCopierCandidateRecords {
  return extractCopierCandidateRecordsWithBinding({
    ...input,
    binding: revalidateCopierCandidateReplayBinding(input.binding),
  })
}

export function extractCopierCandidateRecords(
  input: ExtractCopierCandidateRecordsInput
): ExtractedCopierCandidateRecords {
  return extractCopierCandidateRecordsWithBinding({
    binding: deriveCopierCandidateReplayBinding(input.src),
    exchangeTraderId: input.exchangeTraderId,
    pageIndex: input.pageIndex,
    payload: input.payload,
  })
}

function canonicalPage(page: RawPage, ordinal: number): RawPage {
  if (!isPlainRecord(page)) throw conservationError(`page ${ordinal} must be an object`)
  const safePage = canonicalClone(page, `page ${ordinal}`)
  if (!exactKeys(safePage, ['pageIndex', 'payload', 'url', 'fetchedAt'])) {
    throw conservationError(`page ${ordinal} has unexpected fields`)
  }
  if (safePage.pageIndex !== ordinal) {
    throw conservationError('copier snapshot pages must be contiguous and ordered')
  }
  if (
    typeof safePage.url !== 'string' ||
    safePage.url !== safePage.url.trim() ||
    safePage.url.length < 1 ||
    safePage.url.length > 4096
  ) {
    throw conservationError(`page ${ordinal} URL is invalid`)
  }
  if (
    typeof safePage.fetchedAt !== 'string' ||
    !Number.isFinite(Date.parse(safePage.fetchedAt)) ||
    new Date(Date.parse(safePage.fetchedAt)).toISOString() !== safePage.fetchedAt
  ) {
    throw conservationError(`page ${ordinal} fetchedAt is invalid`)
  }
  return canonicalClone(
    {
      pageIndex: safePage.pageIndex,
      payload: safePage.payload,
      url: safePage.url,
      fetchedAt: safePage.fetchedAt,
    },
    `page ${ordinal}`
  )
}

export function buildCopierCandidateLedger(input: {
  src: SourceRow
  exchangeTraderId: string
  pages: readonly RawPage[]
}): CopierCandidateLedger {
  const liveSource = canonicalLiveReplaySource(input.src)
  const binding = buildReplayBindingFromCanonicalSource(liveSource)
  return buildCopierCandidateLedgerFromReplayBinding({
    binding,
    source: { id: liveSource.id, slug: liveSource.slug },
    exchangeTraderId: input.exchangeTraderId,
    pages: input.pages,
  })
}

/** Rebuild a ledger from immutable evidence without fabricating a SourceRow. */
export function buildCopierCandidateLedgerFromReplayBinding(input: {
  binding: unknown
  source: CopierCandidateReplaySourceCoordinates
  exchangeTraderId: string
  pages: readonly RawPage[]
}): CopierCandidateLedger {
  const binding = revalidateCopierCandidateReplayBinding(input.binding)
  const source = canonicalReplaySource(input.source, binding)
  const traderIdentity = exchangeTraderIdSchema.safeParse(input.exchangeTraderId)
  if (!traderIdentity.success) throw conservationError('exchange trader id is invalid')
  const capturedPages = canonicalClone(input.pages, 'capture pages')
  if (!Array.isArray(capturedPages) || capturedPages.length < 1 || capturedPages.length > 100000) {
    throw conservationError('capture must contain between 1 and 100000 pages')
  }

  const hashes: string[] = []
  const pages = capturedPages.map((candidatePage, pageIndex) => {
    const ordinal = pageIndex + 1
    const page = canonicalPage(candidatePage, ordinal)
    const extracted = extractCopierCandidateRecordsWithBinding({
      binding,
      exchangeTraderId: traderIdentity.data,
      pageIndex: page.pageIndex,
      payload: page.payload,
    })
    const occurrences = extracted.candidates.map((candidate, candidateIndex) => {
      const rawCandidateSha256 = strictCanonicalSha256(candidate)
      hashes.push(rawCandidateSha256)
      return {
        candidate_ordinal: candidateIndex + 1,
        raw_candidate_sha256: rawCandidateSha256,
      }
    })
    return {
      page_ordinal: ordinal,
      source_page_index: page.pageIndex,
      locator_contract: extracted.locatorContract,
      candidate_count: occurrences.length,
      occurrences,
    }
  })

  return canonicalSchemaClone(
    copierCandidateLedgerSchema,
    {
      contract: COPIER_CANDIDATE_LEDGER_CONTRACT,
      serialization_contract: STRICT_CANONICAL_JSON_CONTRACT,
      multiset_contract: COPIER_CANDIDATE_MULTISET_CONTRACT,
      source,
      exchange_trader_id: traderIdentity.data,
      page_count: pages.length,
      observed_candidate_count: hashes.length,
      candidate_multiset_sha256: candidateMultisetSha256(hashes),
      pages,
    },
    'candidate ledger'
  )
}

export function revalidateCopierCandidateLedger(input: {
  src: SourceRow
  exchangeTraderId: string
  pages: readonly RawPage[]
  ledger: unknown
}): CopierCandidateLedger {
  const supplied = canonicalSchemaClone(
    copierCandidateLedgerSchema,
    input.ledger,
    'candidate ledger'
  )
  const rebuilt = buildCopierCandidateLedger(input)
  if (strictCanonicalJson(supplied) !== strictCanonicalJson(rebuilt)) {
    throw conservationError('candidate ledger does not match replayed RAW pages')
  }
  return rebuilt
}

export function revalidateCopierCandidateLedgerFromReplayBinding(input: {
  binding: unknown
  source: CopierCandidateReplaySourceCoordinates
  exchangeTraderId: string
  pages: readonly RawPage[]
  ledger: unknown
}): CopierCandidateLedger {
  const supplied = canonicalSchemaClone(
    copierCandidateLedgerSchema,
    input.ledger,
    'candidate ledger'
  )
  const rebuilt = buildCopierCandidateLedgerFromReplayBinding(input)
  if (strictCanonicalJson(supplied) !== strictCanonicalJson(rebuilt)) {
    throw conservationError('candidate ledger does not match replayed RAW pages')
  }
  return rebuilt
}

export function verifyCopierParserConservation(input: {
  ledger: CopierCandidateLedger
  rows: readonly ParsedHistoryRow[]
}): CopierParserConservationProof {
  const ledger = canonicalSchemaClone(copierCandidateLedgerSchema, input.ledger, 'candidate ledger')
  if (!Array.isArray(input.rows) || input.rows.length > 10000000) {
    throw conservationError('parsed row set exceeds the contract limit')
  }
  if (input.rows.some((row) => row.kind !== 'copiers')) {
    throw conservationError('parsed row kind does not match copiers')
  }

  const rows = input.rows.map((row, rowOrdinal) => {
    if (!isPlainRecord(row.raw)) {
      throw conservationError(`parsed row ${rowOrdinal} RAW candidate must be an object`)
    }
    return {
      row_ordinal: rowOrdinal,
      raw_candidate_sha256: strictCanonicalSha256(row.raw),
    }
  })
  const parsedRawMultisetSha256 = candidateMultisetSha256(
    rows.map((row) => row.raw_candidate_sha256)
  )
  if (
    rows.length !== ledger.observed_candidate_count ||
    parsedRawMultisetSha256 !== ledger.candidate_multiset_sha256
  ) {
    throw conservationError('parser rows do not conserve the captured candidate multiset')
  }

  return canonicalSchemaClone(
    copierParserConservationProofSchema,
    {
      contract: COPIER_PARSER_CONSERVATION_CONTRACT,
      serialization_contract: STRICT_CANONICAL_JSON_CONTRACT,
      candidate_ledger_sha256: strictCanonicalSha256(ledger),
      source: ledger.source,
      exchange_trader_id: ledger.exchange_trader_id,
      observed_candidate_count: ledger.observed_candidate_count,
      parsed_row_count: rows.length,
      candidate_multiset_sha256: ledger.candidate_multiset_sha256,
      parsed_raw_multiset_sha256: parsedRawMultisetSha256,
      rows,
    },
    'parser conservation proof'
  )
}
