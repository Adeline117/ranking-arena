import type { SourceAdapter } from './adapter'
import type { SourceRow, SurfaceCapabilities } from './types'

export type SurfaceCapability = keyof SurfaceCapabilities

/**
 * Resolve the effective capability for one configured source. The adapter's
 * static declaration is an upper bound; a shared adapter may further narrow
 * it for a product-specific source row.
 */
export function supportsSourceSurface(
  adapter: SourceAdapter,
  src: SourceRow,
  surface: SurfaceCapability
): boolean {
  if (!adapter.capabilities[surface]) return false
  return adapter.supportsSurface?.(src, surface) ?? true
}

/** Typed fail-closed signal for callers that bypass capability scheduling. */
export class UnsupportedSourceSurfaceError extends Error {
  readonly code = 'UNSUPPORTED_SOURCE_SURFACE'

  constructor(
    readonly sourceSlug: string,
    readonly surface: SurfaceCapability
  ) {
    super(`[ingest] source "${sourceSlug}" does not expose ${surface}`)
    this.name = 'UnsupportedSourceSurfaceError'
  }
}

export function assertSourceSurfaceSupported(
  adapter: SourceAdapter,
  src: SourceRow,
  surface: SurfaceCapability
): void {
  if (!supportsSourceSurface(adapter, src, surface)) {
    throw new UnsupportedSourceSurfaceError(src.slug, surface)
  }
}
