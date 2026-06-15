'use client'

/**
 * Holding-duration distribution (ARENA_REBUILD_SPEC §2.5c). Renders the
 * per-bucket count of closed positions grouped by how long they were held,
 * from the histogram adapters already capture into
 * `extras.hold_histogram` (MEXC shape: { holdTimeStart, holdTimeEnd,
 * holdCount } where the bounds are seconds). Horizontal bars scaled to the
 * busiest bucket — same single-accent visual language as AssetPreference, so
 * it stays inside the design-token ratchet. Shape-validated and
 * NULL-collapses (renders nothing) when the source exposes no histogram.
 */

import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

interface HoldBucket {
  start: number
  end: number
  count: number
}

/** Top buckets is plenty; the tail is sparse single-position buckets. */
const MAX_ROWS = 12

function parseBuckets(extras: Record<string, unknown>): HoldBucket[] {
  const raw = Array.isArray(extras.hold_histogram) ? extras.hold_histogram : []
  return raw
    .map((b) => b as Record<string, unknown>)
    .filter(
      (b) =>
        Number.isFinite(Number(b.holdTimeStart)) &&
        Number.isFinite(Number(b.holdTimeEnd)) &&
        Number.isFinite(Number(b.holdCount))
    )
    .map((b) => ({
      start: Number(b.holdTimeStart),
      end: Number(b.holdTimeEnd),
      count: Number(b.holdCount),
    }))
    .filter((b) => b.count > 0)
    .slice(0, MAX_ROWS)
}

/** Compact one-bound duration label from seconds (e.g. 12h, 1.5d). */
function fmtSecs(secs: number): string {
  if (secs < 3600) return `${Math.round(secs / 60)}m`
  if (secs < 86400) return `${Math.round(secs / 3600)}h`
  const d = secs / 86400
  return `${d >= 10 ? Math.round(d) : d.toFixed(1)}d`
}

export default function HoldingDistribution({ extras }: { extras: Record<string, unknown> }) {
  const { t } = useLanguage()
  const buckets = parseBuckets(extras)
  if (buckets.length === 0) return null

  const max = Math.max(...buckets.map((b) => b.count), 1)

  return (
    <Box>
      <Text
        size="sm"
        weight="semibold"
        color="primary"
        style={{ marginBottom: tokens.spacing[3], display: 'block' }}
      >
        {t('holdingDistribution')}
      </Text>
      <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
        {buckets.map((b) => (
          <Box
            key={`${b.start}-${b.end}`}
            style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}
          >
            <Text
              size="xs"
              color="secondary"
              style={{ width: 84, flexShrink: 0, whiteSpace: 'nowrap' }}
            >
              {fmtSecs(b.start)}–{fmtSecs(b.end)}
            </Text>
            <Box
              style={{
                flex: 1,
                height: 8,
                borderRadius: tokens.radius.full,
                background: tokens.colors.bg.tertiary,
                overflow: 'hidden',
              }}
            >
              <Box
                style={{
                  width: `${Math.max(2, (b.count / max) * 100)}%`,
                  height: '100%',
                  borderRadius: tokens.radius.full,
                  background: 'var(--color-accent-primary, #6366f1)',
                }}
              />
            </Box>
            <Text
              size="xs"
              color="primary"
              style={{
                width: 40,
                flexShrink: 0,
                textAlign: 'right',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {b.count}
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
  )
}
