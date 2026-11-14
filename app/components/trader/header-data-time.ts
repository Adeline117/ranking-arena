import { describeDataTime } from '@/lib/utils/data-time'

/**
 * The trader header's "Updated …" time. Only source-capture times qualify:
 * the detail's source watermark, then the serving board snapshot's capture
 * time. `trackedSince` (when Arena first saw the trader), the score compute
 * time and the render time are never substitutes; with no valid source time
 * the label stays hidden.
 */
export function resolveHeaderDataTime(
  detailSourceAsOf: string | null | undefined,
  servingSnapshotAsOf: string | null | undefined
): string | undefined {
  return (
    describeDataTime(detailSourceAsOf).iso ?? describeDataTime(servingSnapshotAsOf).iso ?? undefined
  )
}
