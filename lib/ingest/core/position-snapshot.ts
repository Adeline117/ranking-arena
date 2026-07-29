import type { RawBundle } from './types'

/**
 * A replace-all position publication needs positive upstream evidence.
 * Zero parsed rows are a valid empty snapshot only when at least one source
 * page was captured; an empty bundle means acquisition failed or was skipped.
 */
export function assertPositionSnapshotEvidence(bundle: RawBundle, context: string): void {
  if (bundle.pages.length === 0) {
    throw new Error(`[positions] ${context}: snapshot has no captured source page`)
  }
}
