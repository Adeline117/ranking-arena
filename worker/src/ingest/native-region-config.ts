import type { WorkerAuthorityRegion } from './consumed-region-context'

export type NativeRegion = WorkerAuthorityRegion

export type NativeRegionConfigErrorCode =
  | 'execution_region_mismatch'
  | 'invalid_consumed_regions'
  | 'unsupported_native_region'

export class NativeRegionConfigError extends Error {
  readonly code: NativeRegionConfigErrorCode

  constructor(code: NativeRegionConfigErrorCode) {
    super(`[ingest-worker] native region configuration rejected (${code})`)
    this.name = 'NativeRegionConfigError'
    this.code = code
  }
}

export interface NativeRegionConfig {
  readonly consumedRegions: readonly [NativeRegion]
  readonly executionRegion: NativeRegion
  readonly nativeRegion: NativeRegion
}

function isNativeRegion(value: unknown): value is NativeRegion {
  return value === 'local' || value === 'vps_sg'
}

function reject(code: NativeRegionConfigErrorCode): never {
  throw new NativeRegionConfigError(code)
}

/**
 * Reduce process-wide queue and execution configuration to one native region.
 * No raw input is ever included in an error because these values originate in
 * the process environment and may contain operator secrets by mistake.
 */
export function resolveNativeRegionConfig(
  consumedRegions: unknown,
  executionRegion: unknown
): NativeRegionConfig {
  let hasExactlyOneRegion = false
  let nativeRegion: unknown
  try {
    if (Array.isArray(consumedRegions) && consumedRegions.length === 1) {
      nativeRegion = consumedRegions[0]
      hasExactlyOneRegion = true
    }
  } catch {
    return reject('invalid_consumed_regions')
  }
  if (!hasExactlyOneRegion) return reject('invalid_consumed_regions')
  if (!isNativeRegion(nativeRegion)) return reject('unsupported_native_region')
  if (executionRegion !== nativeRegion) return reject('execution_region_mismatch')

  const exactConsumedRegions = Object.freeze([nativeRegion]) as readonly [NativeRegion]
  return Object.freeze({
    consumedRegions: exactConsumedRegions,
    executionRegion: nativeRegion,
    nativeRegion,
  })
}
