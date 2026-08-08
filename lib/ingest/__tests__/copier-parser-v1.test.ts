import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseBinanceCopiersV1 } from '../adapters/binance/copier-parser-v1'
import { BINANCE_HISTORY_PAGE_ENVELOPE_CONTRACT } from '../adapters/binance/history-contract'
import { parseBinanceHistory } from '../adapters/binance/parsers'
import { parseBingxCopiersV1 } from '../adapters/bingx/copier-parser-v1'
import { parseBingxHistory } from '../adapters/bingx/parsers'
import { parseBitgetBotsCopiersV1 } from '../adapters/bitget/bots-copier-parser-v1'
import { parseBitgetBotsCopiers } from '../adapters/bitget/bots-parsers'
import { parseBitgetCopiersV1 } from '../adapters/bitget/copier-parser-v1'
import { parseBitgetCopiers, parseBitgetHistory } from '../adapters/bitget/parsers'
import type { CopierCandidateAdapterSlug } from '../copier-candidate-conservation'
import { buildCopierSnapshotParserContextV1 } from '../copier-parser-context-v1'
import {
  COPIER_SNAPSHOT_PARSER_CONTRACTS,
  buildCopierSnapshotParserContext,
  replayCopierSnapshotParser,
} from '../copier-parser-replay'
import type { ParseCtx, ParsedHistoryRow } from '../core/types'
import { strictCanonicalJson, strictCanonicalSha256 } from '../strict-canonical-json'

function fixture(relativePath: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, '..', 'adapters', relativePath), 'utf8'))
}

function source(relativePath: string): string {
  return readFileSync(join(__dirname, '..', relativePath), 'utf8')
}

const scrapedAt = '2026-08-04T12:00:01.000Z'
const historicalBitgetHistoryPageEnvelopeContractV1 = 'arena.ingest.bitget-history-page@1' as const

function context(sourceSlug: string): ParseCtx {
  return {
    sourceSlug,
    currency: 'USDT',
    tfLabelMap: {},
    scrapedAt,
    meta: {},
  }
}

type FirstBatchAdapter = Extract<
  CopierCandidateAdapterSlug,
  'binance' | 'bingx' | 'bitget' | 'bitget_bots'
>

interface ParityCase {
  name: string
  adapterSlug: FirstBatchAdapter
  raw: unknown
  ctx: ParseCtx
  expectedCount: number
  parseV1: (raw: unknown, ctx: ParseCtx) => ParsedHistoryRow[]
  parseCurrent: (raw: unknown, ctx: ParseCtx) => ParsedHistoryRow[]
}

const binanceFutures = fixture('binance/__tests__/fixtures/copy-traders-p1.json')
const binanceSpot = fixture('binance/__tests__/fixtures/spot-copy-traders-p1.json')
const bingxFollowers = fixture('bingx/__tests__/fixtures/records-followers.json')
const bitgetFollowers = fixture('bitget/__tests__/fixtures/copiers-p1.json')
const bitgetBotsFollowers = fixture('bitget/__tests__/fixtures/bots-follow-rank.json')

function wrapBinance(response: unknown): unknown {
  return {
    contract: BINANCE_HISTORY_PAGE_ENVELOPE_CONTRACT,
    portfolioId: 'trader-91',
    sort: null,
    request: { pageNumber: 1, pageSize: 50, portfolioId: 'trader-91' },
    response,
  }
}

function wrapBitget(response: unknown): unknown {
  return {
    contract: historicalBitgetHistoryPageEnvelopeContractV1,
    historyTraderIdentity: 'trader-91',
    request: { pageNo: 1, pageSize: 10, traderUid: 'trader-91' },
    response,
  }
}

const cases: readonly ParityCase[] = [
  {
    name: 'binance futures envelope',
    adapterSlug: 'binance',
    raw: wrapBinance(binanceFutures),
    ctx: context('binance_futures'),
    expectedCount: 50,
    parseV1: parseBinanceCopiersV1,
    parseCurrent: (raw, ctx) => parseBinanceHistory(raw, 'copiers', ctx),
  },
  {
    name: 'binance spot envelope',
    adapterSlug: 'binance',
    raw: wrapBinance(binanceSpot),
    ctx: context('binance_spot'),
    expectedCount: 50,
    parseV1: parseBinanceCopiersV1,
    parseCurrent: (raw, ctx) => parseBinanceHistory(raw, 'copiers', ctx),
  },
  {
    name: 'bingx followers response',
    adapterSlug: 'bingx',
    raw: bingxFollowers,
    ctx: context('bingx_futures'),
    expectedCount: 12,
    parseV1: parseBingxCopiersV1,
    parseCurrent: (raw, ctx) => parseBingxHistory(raw, 'copiers', ctx),
  },
  {
    name: 'bitget bare response',
    adapterSlug: 'bitget',
    raw: bitgetFollowers,
    ctx: context('bitget_futures'),
    expectedCount: 2,
    parseV1: parseBitgetCopiersV1,
    parseCurrent: (raw, ctx) => parseBitgetHistory(raw, 'copiers', ctx),
  },
  {
    name: 'bitget evidence envelope',
    adapterSlug: 'bitget',
    raw: wrapBitget(bitgetFollowers),
    ctx: context('bitget_futures'),
    expectedCount: 2,
    parseV1: parseBitgetCopiersV1,
    parseCurrent: (raw, ctx) => parseBitgetHistory(raw, 'copiers', ctx),
  },
  {
    name: 'bitget bots follow rank',
    adapterSlug: 'bitget_bots',
    raw: bitgetBotsFollowers,
    ctx: context('bitget_bots_futures'),
    expectedCount: 10,
    parseV1: parseBitgetBotsCopiersV1,
    parseCurrent: parseBitgetBotsCopiers,
  },
]

describe('append-only copier parser V1 first batch', () => {
  it('keeps current adapters and retained replay byte-equivalent on real fixtures', () => {
    const digests = cases.map((testCase) => {
      const versioned = testCase.parseV1(testCase.raw, testCase.ctx)
      const current = testCase.parseCurrent(testCase.raw, testCase.ctx)
      const replayed = replayCopierSnapshotParser({
        adapterSlug: testCase.adapterSlug,
        parserContract: COPIER_SNAPSHOT_PARSER_CONTRACTS[testCase.adapterSlug],
        raw: testCase.raw,
        ctx: testCase.ctx,
      })

      const canonical = strictCanonicalJson(versioned)
      expect(versioned).toHaveLength(testCase.expectedCount)
      expect(strictCanonicalJson(current)).toBe(canonical)
      expect(strictCanonicalJson(replayed)).toBe(canonical)

      return {
        case: testCase.name,
        rowCount: versioned.length,
        sha256: strictCanonicalSha256(versioned),
      }
    })

    expect(digests).toMatchSnapshot()
  })

  it('normalizes Bitget bare and evidence-envelope inputs through one V1 path', () => {
    const ctx = context('bitget_futures')
    const bare = parseBitgetCopiersV1(bitgetFollowers, ctx)
    const wrapped = parseBitgetCopiersV1(wrapBitget(bitgetFollowers), ctx)

    expect(strictCanonicalJson(wrapped)).toBe(strictCanonicalJson(bare))
    expect(parseBitgetCopiers(bitgetFollowers, ctx)).toEqual(bare)
    expect(parseBitgetCopiers(wrapBitget(bitgetFollowers), ctx)).toEqual(bare)
    expect(parseBitgetHistory(wrapBitget(bitgetFollowers), 'copiers', ctx)).toEqual(bare)
  })

  it('retains the exact V1 context policy behind the public dispatcher', () => {
    for (const adapterSlug of ['binance', 'bingx', 'bitget', 'bitget_bots', 'gate'] as const) {
      const input = {
        productType: adapterSlug === 'gate' ? ('cfd' as const) : ('futures' as const),
        sourceSlug: `${adapterSlug}_futures`,
        currency: 'USDT' as const,
        scrapedAt,
      }
      const versioned = buildCopierSnapshotParserContextV1(adapterSlug, input)
      const dispatched = buildCopierSnapshotParserContext({
        adapterSlug,
        parserContract: COPIER_SNAPSHOT_PARSER_CONTRACTS[adapterSlug],
        ...input,
      })

      expect(strictCanonicalJson(dispatched)).toBe(strictCanonicalJson(versioned))
      expect(Object.isFrozen(dispatched)).toBe(true)
      expect(Object.isFrozen(dispatched.tfLabelMap)).toBe(true)
      expect(Object.isFrozen(dispatched.meta)).toBe(true)
      expect(dispatched.meta).toEqual(adapterSlug === 'gate' ? { boardKey: 'cfd' } : {})
    }
  })

  it('keeps historical replay isolated from mutable current parser modules', () => {
    const replaySource = source('copier-parser-replay.ts')
    const forbiddenReplayImports = [
      './adapters/binance/parsers',
      './adapters/bingx/parsers',
      './adapters/bitget/parsers',
      './adapters/bitget/bots-parsers',
    ]
    for (const importPath of forbiddenReplayImports) {
      expect(replaySource).not.toContain(`from '${importPath}'`)
      expect(replaySource).not.toContain(`from \"${importPath}\"`)
    }
    for (const importPath of [
      './adapters/binance/copier-parser-v1',
      './adapters/bingx/copier-parser-v1',
      './adapters/bitget/copier-parser-v1',
      './adapters/bitget/bots-copier-parser-v1',
      './copier-parser-context-v1',
    ]) {
      expect(replaySource).toContain(importPath)
    }

    const currentDelegates = [
      ['adapters/binance/parsers.ts', './copier-parser-v1', 'parseBinanceCopiersV1(raw, ctx)'],
      ['adapters/bingx/parsers.ts', './copier-parser-v1', 'parseBingxCopiersV1(raw, ctx)'],
      ['adapters/bitget/parsers.ts', './copier-parser-v1', 'parseBitgetCopiersV1(raw, ctx)'],
      [
        'adapters/bitget/bots-parsers.ts',
        './bots-copier-parser-v1',
        'parseBitgetBotsCopiersV1(raw, ctx)',
      ],
    ] as const
    for (const [file, importPath, delegation] of currentDelegates) {
      const contents = source(file)
      expect(contents).toContain(importPath)
      expect(contents).toContain(delegation)
    }

    const versionedSources = [
      'adapters/binance/copier-parser-v1.ts',
      'adapters/bingx/copier-parser-v1.ts',
      'adapters/bitget/copier-parser-v1.ts',
      'adapters/bitget/bots-copier-parser-v1.ts',
    ]
    for (const file of versionedSources) {
      const contents = source(file)
      expect(contents).toContain('Append-only implementation')
      expect(contents).not.toMatch(
        /from ['\"][^'\"]*(?:\/parsers|\/index|copier-parser-replay)['\"]/
      )
    }

    const bitgetV1Source = source('adapters/bitget/copier-parser-v1.ts')
    expect(bitgetV1Source).toContain("'arena.ingest.bitget-history-page@1'")
    expect(bitgetV1Source).not.toMatch(/from ['\"][^'\"]*history-terminal['\"]/)

    const contextSource = source('copier-parser-context-v1.ts')
    expect(contextSource).toContain('Append-only context policy')
    expect(contextSource).not.toContain('copier-parser-replay')
  })
})
