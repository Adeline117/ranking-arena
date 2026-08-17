import type { Job } from 'bullmq'

export type AvatarMirrorResult = {
  mirrored: number
  failed: number
}

/**
 * Compatibility no-op for legacy queued payloads. V1 does not publish avatar
 * mirror execution, so callers receive the historical result shape without
 * performing work.
 */
export async function processAvatarMirror(_job: Job): Promise<AvatarMirrorResult> {
  return { mirrored: 0, failed: 0 }
}
