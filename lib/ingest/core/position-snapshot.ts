/**
 * Fail-closed parsing for open-position snapshots (Tier-D / Tier-C positions).
 *
 * publishPositions REPLACES a trader's whole `positions_current` set
 * (DELETE + INSERT), so an empty parse result means "the trader is flat".
 * That conclusion is only allowed from a captured, schema-valid response:
 *   - zero captured pages is a failed fetch, never an empty book;
 *   - every parsed row must satisfy `parsedPositionSchema`;
 *   - adapter parsers throw on HTTP-200 business-error envelopes
 *     (see bitget/gate parsePositions), which propagates from here.
 * Any throw leaves the previous snapshot untouched.
 */

import type { ParseCtx, ParsedPosition, RawPage } from './types'
import { parsedPositionSchema } from './schemas'

export function parsePositionSnapshot(
  parse: (raw: unknown, ctx: ParseCtx) => ParsedPosition[],
  pages: readonly RawPage[],
  ctx: ParseCtx
): ParsedPosition[] {
  if (pages.length === 0) {
    throw new Error(`[positions] ${ctx.sourceSlug}: capture returned no evidence page`)
  }
  const positions = pages.flatMap((page) => parse(page.payload, ctx))
  positions.forEach((position, index) => {
    const result = parsedPositionSchema.safeParse(position)
    if (!result.success) {
      const issue = result.error.issues[0]
      throw new Error(
        `[positions] ${ctx.sourceSlug}: row ${index} failed schema ` +
          `(${issue?.path.join('.') || '<root>'}: ${issue?.message ?? 'invalid'})`
      )
    }
  })
  return positions
}
