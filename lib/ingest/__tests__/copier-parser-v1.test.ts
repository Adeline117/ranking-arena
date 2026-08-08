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
import { parseBitunixCopiersV1 } from '../adapters/bitunix/copier-parser-v1'
import { parseBitunixHistory } from '../adapters/bitunix/parsers'
import { parseBlofinCopiersV1 } from '../adapters/blofin/copier-parser-v1'
import { parseBlofinHistory } from '../adapters/blofin/parsers'
import { parseBtccCopiersV1 } from '../adapters/btcc/copier-parser-v1'
import { parseBtccHistory } from '../adapters/btcc/parsers'
import { parseBybitCopytradeCopiersV1 } from '../adapters/bybit-copytrade/copier-parser-v1'
import { parseBybitCopytradeHistory } from '../adapters/bybit-copytrade/parsers'
import { parseCoinexCopiersV1 } from '../adapters/coinex/copier-parser-v1'
import { parseCoinexHistory } from '../adapters/coinex/parsers'
import { parseGateCopiersV1 } from '../adapters/gate/copier-parser-v1'
import { parseGateHistory } from '../adapters/gate/parsers'
import { parseKucoinCopiersV1 } from '../adapters/kucoin/copier-parser-v1'
import { parseKucoinHistory } from '../adapters/kucoin/parsers'
import { parseLbankCopiersV1 } from '../adapters/lbank/copier-parser-v1'
import { parseLbankHistory } from '../adapters/lbank/parsers'
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

type VersionedAdapter = Extract<
  CopierCandidateAdapterSlug,
  | 'binance'
  | 'bingx'
  | 'bitget'
  | 'bitget_bots'
  | 'bitunix'
  | 'blofin'
  | 'btcc'
  | 'bybit_copytrade'
  | 'coinex'
  | 'gate'
  | 'kucoin'
  | 'lbank'
>

interface ParityCase {
  name: string
  adapterSlug: VersionedAdapter
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
const bitunixFollowers = fixture('bitunix/__tests__/fixtures/follow-list-p1.json')
const blofinFollowers = fixture('blofin/__tests__/fixtures/records-copiers.json')
const btccFollowers = fixture('btcc/__tests__/fixtures/followers-p1.json')
const bybitCopytradeFollowers = fixture('bybit-copytrade/__tests__/fixtures/other-follower-p1.json')
const coinexFollowers = fixture('coinex/__tests__/fixtures/followers-p1.json')
const gateFuturesFollowers = fixture('gate/__tests__/fixtures/follow-user-p1.json')
const gateCfdFollowers = fixture('gate/__tests__/fixtures/followers-cfd-p1.json')
const kucoinFollowers = fixture('kucoin/__tests__/fixtures/copy-traders-p1.json')
const lbankFollowers = fixture('lbank/__tests__/fixtures/followers-p1.json')

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
  {
    name: 'bitunix follow list',
    adapterSlug: 'bitunix',
    raw: bitunixFollowers,
    ctx: context('bitunix_futures'),
    expectedCount: 3,
    parseV1: parseBitunixCopiersV1,
    parseCurrent: (raw, ctx) => parseBitunixHistory(raw, 'copiers', ctx),
  },
  {
    name: 'blofin copiers',
    adapterSlug: 'blofin',
    raw: blofinFollowers,
    ctx: context('blofin_futures'),
    expectedCount: 20,
    parseV1: parseBlofinCopiersV1,
    parseCurrent: (raw, ctx) => parseBlofinHistory(raw, 'copiers', ctx),
  },
  {
    name: 'btcc followers',
    adapterSlug: 'btcc',
    raw: btccFollowers,
    ctx: context('btcc_futures'),
    expectedCount: 3,
    parseV1: parseBtccCopiersV1,
    parseCurrent: (raw, ctx) => parseBtccHistory(raw, 'copiers', ctx),
  },
  {
    name: 'bybit copytrade followers',
    adapterSlug: 'bybit_copytrade',
    raw: bybitCopytradeFollowers,
    ctx: context('bybit_copytrade_futures'),
    expectedCount: 18,
    parseV1: parseBybitCopytradeCopiersV1,
    parseCurrent: (raw, ctx) => parseBybitCopytradeHistory(raw, 'copiers', ctx),
  },
  {
    name: 'coinex followers',
    adapterSlug: 'coinex',
    raw: coinexFollowers,
    ctx: context('coinex_futures'),
    expectedCount: 10,
    parseV1: parseCoinexCopiersV1,
    parseCurrent: (raw, ctx) => parseCoinexHistory(raw, 'copiers', ctx),
  },
  {
    name: 'gate futures follow users',
    adapterSlug: 'gate',
    raw: gateFuturesFollowers,
    ctx: {
      ...context('gate_futures'),
      meta: { boardKey: 'futures' },
    },
    expectedCount: 3,
    parseV1: parseGateCopiersV1,
    parseCurrent: (raw, ctx) => parseGateHistory(raw, 'copiers', ctx),
  },
  {
    name: 'gate CFD followers',
    adapterSlug: 'gate',
    raw: gateCfdFollowers,
    ctx: {
      ...context('gate_cfd'),
      currency: 'USDx',
      meta: { boardKey: 'cfd' },
    },
    expectedCount: 3,
    parseV1: parseGateCopiersV1,
    parseCurrent: (raw, ctx) => parseGateHistory(raw, 'copiers', ctx),
  },
  {
    name: 'kucoin copy traders',
    adapterSlug: 'kucoin',
    raw: kucoinFollowers,
    ctx: context('kucoin_futures'),
    expectedCount: 3,
    parseV1: parseKucoinCopiersV1,
    parseCurrent: (raw, ctx) => parseKucoinHistory(raw, 'copiers', ctx),
  },
  {
    name: 'lbank followers',
    adapterSlug: 'lbank',
    raw: lbankFollowers,
    ctx: context('lbank_futures'),
    expectedCount: 3,
    parseV1: parseLbankCopiersV1,
    parseCurrent: (raw, ctx) => parseLbankHistory(raw, 'copiers', ctx),
  },
]

describe('append-only copier parser V1', () => {
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

  it('keeps Gate futures and CFD copier variants distinct', () => {
    const futuresCtx: ParseCtx = {
      ...context('gate_futures'),
      meta: { boardKey: 'futures' },
    }
    const cfdCtx: ParseCtx = {
      ...context('gate_cfd'),
      currency: 'USDx',
      meta: { boardKey: 'cfd' },
    }
    const futures = parseGateCopiersV1(gateFuturesFollowers, futuresCtx)
    const cfd = parseGateCopiersV1(gateCfdFollowers, cfdCtx)

    expect(futures[0]).toMatchObject({
      copierLabel: '682318',
      ts: new Date(1_780_586_472_000).toISOString(),
      copierInvested: 2750,
      copyDurationDays: null,
    })
    expect(cfd[0]).toMatchObject({
      copierLabel: '景裕1',
      ts: scrapedAt,
      copierInvested: 33500,
      copyDurationDays: 4,
    })
  })

  it('pins KuCoin strict numeric grammar and scrape-clock semantics', () => {
    const ctx = context('kucoin_futures')
    const raw = {
      data: {
        totalNum: '0x1',
        items: [
          {
            nickName: 'masked-user',
            pnl: ' 1.25 ',
            copyPrincipal: '0x10',
            copyDays: '2.6e0',
            statTime: 1,
          },
        ],
      },
    }
    const versioned = parseKucoinCopiersV1(raw, ctx)
    const replayed = replayCopierSnapshotParser({
      adapterSlug: 'kucoin',
      parserContract: COPIER_SNAPSHOT_PARSER_CONTRACTS.kucoin,
      raw,
      ctx,
    })

    expect(versioned).toHaveLength(1)
    expect(versioned[0]).toMatchObject({
      ts: scrapedAt,
      copierPnl: 1.25,
      copierInvested: null,
      copyDurationDays: 3,
    })
    expect(parseKucoinHistory(raw, 'copiers', ctx)).toEqual(versioned)
    expect(replayed).toEqual(versioned)
  })

  it('retains the exact V1 context policy behind the public dispatcher', () => {
    for (const adapterSlug of [
      'binance',
      'bingx',
      'bitget',
      'bitget_bots',
      'bitunix',
      'blofin',
      'btcc',
      'bybit_copytrade',
      'coinex',
      'kucoin',
      'lbank',
      'gate',
    ] as const) {
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
      './adapters/bitunix/parsers',
      './adapters/blofin/parsers',
      './adapters/btcc/parsers',
      './adapters/bybit-copytrade/parsers',
      './adapters/coinex/parsers',
      './adapters/gate/parsers',
      './adapters/kucoin/parsers',
      './adapters/lbank/parsers',
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
      './adapters/bitunix/copier-parser-v1',
      './adapters/blofin/copier-parser-v1',
      './adapters/btcc/copier-parser-v1',
      './adapters/bybit-copytrade/copier-parser-v1',
      './adapters/coinex/copier-parser-v1',
      './adapters/gate/copier-parser-v1',
      './adapters/kucoin/copier-parser-v1',
      './adapters/lbank/copier-parser-v1',
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
      ['adapters/bitunix/parsers.ts', './copier-parser-v1', 'parseBitunixCopiersV1(raw, ctx)'],
      ['adapters/blofin/parsers.ts', './copier-parser-v1', 'parseBlofinCopiersV1(raw, ctx)'],
      ['adapters/btcc/parsers.ts', './copier-parser-v1', 'parseBtccCopiersV1(raw, ctx)'],
      [
        'adapters/bybit-copytrade/parsers.ts',
        './copier-parser-v1',
        'parseBybitCopytradeCopiersV1(raw, ctx)',
      ],
      ['adapters/coinex/parsers.ts', './copier-parser-v1', 'parseCoinexCopiersV1(raw, ctx)'],
      ['adapters/gate/parsers.ts', './copier-parser-v1', 'parseGateCopiersV1(raw, ctx)'],
      ['adapters/kucoin/parsers.ts', './copier-parser-v1', 'parseKucoinCopiersV1(raw, ctx)'],
      ['adapters/lbank/parsers.ts', './copier-parser-v1', 'parseLbankCopiersV1(raw, ctx)'],
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
      'adapters/bitunix/copier-parser-v1.ts',
      'adapters/blofin/copier-parser-v1.ts',
      'adapters/btcc/copier-parser-v1.ts',
      'adapters/bybit-copytrade/copier-parser-v1.ts',
      'adapters/coinex/copier-parser-v1.ts',
      'adapters/gate/copier-parser-v1.ts',
      'adapters/kucoin/copier-parser-v1.ts',
      'adapters/lbank/copier-parser-v1.ts',
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
