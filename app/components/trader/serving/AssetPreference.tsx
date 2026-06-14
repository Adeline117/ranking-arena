'use client'

/**
 * Asset Preference module (ARENA_DATA_SPEC EXCHANGE_FIELD_MAPPING §6).
 *
 * Renders the trader's traded-asset distribution from
 * `core.modules.extras.trading_preferences.assets` ([{ asset, volume }] where
 * volume is the percent weight, already including an "OTHER" bucket). Single
 * accent-colored proportional bars — no multi-hue palette, so it stays inside
 * the design-token ratchet. NULL-collapses (renders nothing) when the source
 * exposes no preference data, matching the rest of the serving panel.
 */

import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

interface AssetWeight {
  asset: string
  volume: number
}

/** Top-N + OTHER is plenty; exchanges already pre-bucket the long tail. */
const MAX_ROWS = 10

function parseAssets(extras: Record<string, unknown>): AssetWeight[] {
  const tp = extras.trading_preferences as { assets?: unknown } | undefined
  const raw = Array.isArray(tp?.assets) ? tp.assets : []
  const assets = raw
    .map((a) => a as Record<string, unknown>)
    .filter((a) => typeof a.asset === 'string' && Number.isFinite(Number(a.volume)))
    .map((a) => ({ asset: String(a.asset), volume: Number(a.volume) }))
  return assets.sort((x, y) => y.volume - x.volume).slice(0, MAX_ROWS)
}

export default function AssetPreference({ extras }: { extras: Record<string, unknown> }) {
  const { t } = useLanguage()
  const assets = parseAssets(extras)
  if (assets.length === 0) return null

  // Scale bars to the largest weight so the leader fills the track.
  const max = Math.max(...assets.map((a) => a.volume), 1)

  return (
    <Box>
      <Text
        size="sm"
        weight="semibold"
        color="primary"
        style={{ marginBottom: tokens.spacing[3], display: 'block' }}
      >
        {t('assetPreference')}
      </Text>
      <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
        {assets.map((a) => {
          const label = a.asset === 'OTHER' ? t('assetOther') : a.asset
          return (
            <Box
              key={a.asset}
              style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}
            >
              <Text
                size="xs"
                color="secondary"
                style={{
                  width: 72,
                  flexShrink: 0,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {label}
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
                    width: `${Math.max(2, (a.volume / max) * 100)}%`,
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
                  width: 48,
                  flexShrink: 0,
                  textAlign: 'right',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {a.volume.toFixed(1)}%
              </Text>
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}
