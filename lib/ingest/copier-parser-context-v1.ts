import type { CopierCandidateAdapterSlug } from './copier-candidate-conservation'
import type { Currency, ParseCtx, ProductType } from './core/types'

/**
 * Append-only context policy for arena.ingest.copier-parser.*@1.
 * Never change this module after the contracts are published; add a new version instead.
 */

export type CopierParserContextV1Input = Readonly<{
  productType: ProductType
  sourceSlug: string
  currency: Currency
  scrapedAt: string
}>

export function buildCopierSnapshotParserContextV1(
  adapterSlug: CopierCandidateAdapterSlug,
  input: CopierParserContextV1Input
): Readonly<ParseCtx> {
  const meta =
    adapterSlug === 'gate'
      ? Object.freeze({ boardKey: input.productType as 'futures' | 'cfd' })
      : Object.freeze({})

  return Object.freeze({
    sourceSlug: input.sourceSlug,
    currency: input.currency,
    tfLabelMap: Object.freeze({}),
    scrapedAt: input.scrapedAt,
    meta,
  })
}
