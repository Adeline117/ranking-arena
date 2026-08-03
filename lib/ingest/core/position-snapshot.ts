import type { RawBundle } from './types'

const SUCCESS_CODES = new Set<unknown>([0, '0', 200, '200', '00000', '000000'])
const SUCCESS_ERRNOS = new Set<unknown>([0, '0', 'OK'])
const POSITION_SNAPSHOT_EVIDENCE = Symbol('validated-position-snapshot')

export interface PositionSnapshotEvidence {
  readonly context: string
  readonly pageCount: number
  readonly [POSITION_SNAPSHOT_EVIDENCE]: true
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function assertPositionPagePayload(payload: unknown, context: string, pageIndex: number): void {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload) ||
    Object.keys(payload).length === 0
  ) {
    throw new Error(`[positions] ${context}: page ${pageIndex} has no response envelope`)
  }

  const envelope = payload as Record<string, unknown>
  if (hasOwn(envelope, 'success') && envelope.success !== true) {
    throw new Error(`[positions] ${context}: page ${pageIndex} reports unsuccessful response`)
  }
  if (hasOwn(envelope, 'code') && !SUCCESS_CODES.has(envelope.code)) {
    throw new Error(
      `[positions] ${context}: page ${pageIndex} reports failure code ${String(envelope.code)}`
    )
  }
  if (hasOwn(envelope, 'retCode') && envelope.retCode !== 0 && envelope.retCode !== '0') {
    throw new Error(
      `[positions] ${context}: page ${pageIndex} reports failure retCode ${String(envelope.retCode)}`
    )
  }
  if (hasOwn(envelope, 'errno') && !SUCCESS_ERRNOS.has(envelope.errno)) {
    throw new Error(
      `[positions] ${context}: page ${pageIndex} reports failure errno ${String(envelope.errno)}`
    )
  }
}

/**
 * A replace-all position publication needs positive upstream evidence.
 * Zero parsed rows are a valid empty snapshot only when at least one source
 * page was captured; an empty bundle means acquisition failed or was skipped.
 */
export function assertPositionSnapshotEvidence(
  bundle: RawBundle,
  context: string
): PositionSnapshotEvidence {
  if (bundle.pages.length === 0) {
    throw new Error(`[positions] ${context}: snapshot has no captured source page`)
  }

  const pageIndexes = new Set<number>()
  for (const page of bundle.pages) {
    if (
      !Number.isSafeInteger(page.pageIndex) ||
      page.pageIndex < 1 ||
      pageIndexes.has(page.pageIndex)
    ) {
      throw new Error(`[positions] ${context}: snapshot has invalid source page identity`)
    }
    pageIndexes.add(page.pageIndex)
    assertPositionPagePayload(page.payload, context, page.pageIndex)
  }

  return Object.freeze({
    context,
    pageCount: bundle.pages.length,
    [POSITION_SNAPSHOT_EVIDENCE]: true as const,
  })
}

/** Runtime counterpart to the required TypeScript capability on replace-all writes. */
export function assertPositionPublicationEvidence(evidence: PositionSnapshotEvidence): void {
  if (
    typeof evidence !== 'object' ||
    evidence === null ||
    evidence[POSITION_SNAPSHOT_EVIDENCE] !== true ||
    !Number.isSafeInteger(evidence.pageCount) ||
    evidence.pageCount < 1
  ) {
    throw new Error('[positions] replace-all publication lacks validated source evidence')
  }
}
