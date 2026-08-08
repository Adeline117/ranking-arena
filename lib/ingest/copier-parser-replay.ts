import { parseBinanceCopiersV1 } from './adapters/binance/copier-parser-v1'
import { parseBingxCopiersV1 } from './adapters/bingx/copier-parser-v1'
import { parseBitgetBotsCopiersV1 } from './adapters/bitget/bots-copier-parser-v1'
import { parseBitgetCopiersV1 } from './adapters/bitget/copier-parser-v1'
import { parseBitunixHistory } from './adapters/bitunix/parsers'
import { parseBlofinHistory } from './adapters/blofin/parsers'
import { parseBtccHistory } from './adapters/btcc/parsers'
import { parseBybitCopytradeHistory } from './adapters/bybit-copytrade/parsers'
import { parseCoinexHistory } from './adapters/coinex/parsers'
import { parseGateHistory } from './adapters/gate/parsers'
import { parseKucoinHistory } from './adapters/kucoin/parsers'
import { parseLbankHistory } from './adapters/lbank/parsers'
import { parseMexcHistory } from './adapters/mexc/parsers'
import { parseOkxHistory } from './adapters/okx/parsers'
import { parseToobitHistory } from './adapters/toobit/parsers'
import { parseXtHistory } from './adapters/xt/parsers'
import {
  COPIER_CANDIDATE_ADAPTER_SLUGS,
  type CopierCandidateAdapterSlug,
} from './copier-candidate-conservation'
import {
  buildCopierSnapshotParserContextV1,
  type CopierParserContextV1Input,
} from './copier-parser-context-v1'
import type { Currency, ParseCtx, ParsedHistoryRow, ProductType } from './core/types'

export type CopierSnapshotParserContract =
  `arena.ingest.copier-parser.${CopierCandidateAdapterSlug}@${number}`

/** Retained V1 identities never move when the active contract advances. */
const COPIER_SNAPSHOT_PARSER_V1_CONTRACTS = Object.freeze({
  binance: 'arena.ingest.copier-parser.binance@1',
  bingx: 'arena.ingest.copier-parser.bingx@1',
  bitget: 'arena.ingest.copier-parser.bitget@1',
  bitget_bots: 'arena.ingest.copier-parser.bitget_bots@1',
  bitunix: 'arena.ingest.copier-parser.bitunix@1',
  blofin: 'arena.ingest.copier-parser.blofin@1',
  btcc: 'arena.ingest.copier-parser.btcc@1',
  bybit_copytrade: 'arena.ingest.copier-parser.bybit_copytrade@1',
  coinex: 'arena.ingest.copier-parser.coinex@1',
  gate: 'arena.ingest.copier-parser.gate@1',
  kucoin: 'arena.ingest.copier-parser.kucoin@1',
  lbank: 'arena.ingest.copier-parser.lbank@1',
  mexc: 'arena.ingest.copier-parser.mexc@1',
  okx: 'arena.ingest.copier-parser.okx@1',
  toobit: 'arena.ingest.copier-parser.toobit@1',
  xt: 'arena.ingest.copier-parser.xt@1',
} satisfies Readonly<Record<CopierCandidateAdapterSlug, CopierSnapshotParserContract>>)

/** Active contracts are used only while constructing new evidence. */
export const COPIER_SNAPSHOT_PARSER_CONTRACTS = Object.freeze({
  ...COPIER_SNAPSHOT_PARSER_V1_CONTRACTS,
})

interface CopierParserReplayImplementation {
  readonly adapterSlug: CopierCandidateAdapterSlug
  readonly replay: (raw: unknown, ctx: ParseCtx) => ParsedHistoryRow[]
  readonly buildContext: (input: CopierParserContextV1Input) => Readonly<ParseCtx>
}

function parserV1(
  adapterSlug: CopierCandidateAdapterSlug,
  replay: CopierParserReplayImplementation['replay']
): CopierParserReplayImplementation {
  return Object.freeze({
    adapterSlug,
    replay,
    buildContext: (input: CopierParserContextV1Input) =>
      buildCopierSnapshotParserContextV1(adapterSlug, input),
  })
}

/**
 * Append-only historical catalog. Existing entries must retain their exact
 * implementation and context policy when a new active parser is introduced.
 */
const COPIER_SNAPSHOT_PARSER_IMPLEMENTATIONS: Readonly<
  Record<string, CopierParserReplayImplementation>
> = Object.freeze({
  [COPIER_SNAPSHOT_PARSER_V1_CONTRACTS.binance]: parserV1('binance', parseBinanceCopiersV1),
  [COPIER_SNAPSHOT_PARSER_V1_CONTRACTS.bingx]: parserV1('bingx', parseBingxCopiersV1),
  [COPIER_SNAPSHOT_PARSER_V1_CONTRACTS.bitget]: parserV1('bitget', parseBitgetCopiersV1),
  [COPIER_SNAPSHOT_PARSER_V1_CONTRACTS.bitget_bots]: parserV1(
    'bitget_bots',
    parseBitgetBotsCopiersV1
  ),
  [COPIER_SNAPSHOT_PARSER_V1_CONTRACTS.bitunix]: parserV1('bitunix', (raw, ctx) =>
    parseBitunixHistory(raw, 'copiers', ctx)
  ),
  [COPIER_SNAPSHOT_PARSER_V1_CONTRACTS.blofin]: parserV1('blofin', (raw, ctx) =>
    parseBlofinHistory(raw, 'copiers', ctx)
  ),
  [COPIER_SNAPSHOT_PARSER_V1_CONTRACTS.btcc]: parserV1('btcc', (raw, ctx) =>
    parseBtccHistory(raw, 'copiers', ctx)
  ),
  [COPIER_SNAPSHOT_PARSER_V1_CONTRACTS.bybit_copytrade]: parserV1('bybit_copytrade', (raw, ctx) =>
    parseBybitCopytradeHistory(raw, 'copiers', ctx)
  ),
  [COPIER_SNAPSHOT_PARSER_V1_CONTRACTS.coinex]: parserV1('coinex', (raw, ctx) =>
    parseCoinexHistory(raw, 'copiers', ctx)
  ),
  [COPIER_SNAPSHOT_PARSER_V1_CONTRACTS.gate]: parserV1('gate', (raw, ctx) =>
    parseGateHistory(raw, 'copiers', ctx)
  ),
  [COPIER_SNAPSHOT_PARSER_V1_CONTRACTS.kucoin]: parserV1('kucoin', (raw, ctx) =>
    parseKucoinHistory(raw, 'copiers', ctx)
  ),
  [COPIER_SNAPSHOT_PARSER_V1_CONTRACTS.lbank]: parserV1('lbank', (raw, ctx) =>
    parseLbankHistory(raw, 'copiers', ctx)
  ),
  [COPIER_SNAPSHOT_PARSER_V1_CONTRACTS.mexc]: parserV1('mexc', (raw, ctx) =>
    parseMexcHistory(raw, 'copiers', ctx)
  ),
  [COPIER_SNAPSHOT_PARSER_V1_CONTRACTS.okx]: parserV1('okx', (raw, ctx) =>
    parseOkxHistory(raw, 'copiers', ctx)
  ),
  [COPIER_SNAPSHOT_PARSER_V1_CONTRACTS.toobit]: parserV1('toobit', (raw, ctx) =>
    parseToobitHistory(raw, 'copiers', ctx)
  ),
  [COPIER_SNAPSHOT_PARSER_V1_CONTRACTS.xt]: parserV1('xt', (raw, ctx) =>
    parseXtHistory(raw, 'copiers', ctx)
  ),
})

function parserReplayError(detail: string): Error {
  return new Error(`[ingest] copier parser replay failed: ${detail}`)
}

export function selectCopierSnapshotParserContract(
  adapterSlug: CopierCandidateAdapterSlug
): CopierSnapshotParserContract {
  if (!Object.prototype.hasOwnProperty.call(COPIER_SNAPSHOT_PARSER_CONTRACTS, adapterSlug)) {
    throw parserReplayError(`adapter ${String(adapterSlug)} has no closed parser contract`)
  }
  const selected = COPIER_SNAPSHOT_PARSER_CONTRACTS[adapterSlug]
  if (!selected) {
    throw parserReplayError(`adapter ${String(adapterSlug)} has no closed parser contract`)
  }
  return selected
}

/** Validate any retained historical contract without requiring it to be active. */
export function revalidateCopierSnapshotParserContract(
  adapterSlug: CopierCandidateAdapterSlug,
  parserContract: unknown
): CopierSnapshotParserContract {
  if (
    typeof parserContract !== 'string' ||
    !Object.prototype.hasOwnProperty.call(COPIER_SNAPSHOT_PARSER_IMPLEMENTATIONS, parserContract)
  ) {
    throw parserReplayError('parser contract is not implemented')
  }
  const implementation = COPIER_SNAPSHOT_PARSER_IMPLEMENTATIONS[parserContract]
  if (!implementation || implementation.adapterSlug !== adapterSlug) {
    throw parserReplayError('adapter and parser contract do not match')
  }
  return parserContract as CopierSnapshotParserContract
}

/** Build the exact parser context governed by the retained replay contract. */
export function buildCopierSnapshotParserContext(input: {
  adapterSlug: CopierCandidateAdapterSlug
  parserContract: CopierSnapshotParserContract
  productType: ProductType
  sourceSlug: string
  currency: Currency
  scrapedAt: string
}): Readonly<ParseCtx> {
  const contract = revalidateCopierSnapshotParserContract(input.adapterSlug, input.parserContract)
  return COPIER_SNAPSHOT_PARSER_IMPLEMENTATIONS[contract].buildContext({
    productType: input.productType,
    sourceSlug: input.sourceSlug,
    currency: input.currency,
    scrapedAt: input.scrapedAt,
  })
}

/** Replay only the implementation named by the retained durable contract. */
export function replayCopierSnapshotParser(input: {
  adapterSlug: CopierCandidateAdapterSlug
  parserContract: CopierSnapshotParserContract
  raw: unknown
  ctx: ParseCtx
}): ParsedHistoryRow[] {
  const contract = revalidateCopierSnapshotParserContract(input.adapterSlug, input.parserContract)
  return COPIER_SNAPSHOT_PARSER_IMPLEMENTATIONS[contract].replay(input.raw, input.ctx)
}

if (
  Object.keys(COPIER_SNAPSHOT_PARSER_CONTRACTS).length !== COPIER_CANDIDATE_ADAPTER_SLUGS.length
) {
  throw parserReplayError('active parser registry does not cover every candidate adapter')
}

for (const [adapterSlug, contract] of Object.entries(COPIER_SNAPSHOT_PARSER_CONTRACTS)) {
  if (
    !Object.prototype.hasOwnProperty.call(COPIER_SNAPSHOT_PARSER_IMPLEMENTATIONS, contract) ||
    COPIER_SNAPSHOT_PARSER_IMPLEMENTATIONS[contract].adapterSlug !== adapterSlug
  ) {
    throw parserReplayError(`active parser contract for ${adapterSlug} is not retained`)
  }
}
