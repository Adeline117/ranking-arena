'use client'

/**
 * Serving-mode profile body (ARENA_DATA_SPEC v1.2 §2.4).
 *
 * Replaces the legacy tabs+content block when the source reads from
 * arena.* — the page header/hero above it already rendered from Tier-A
 * first-screen data with zero on-demand fetching. This panel owns:
 *
 *   2. Core modules — ONE request per timeframe (useTraderCore), local
 *      skeletons, module-level degradation only.
 *   3. Heavy record tabs — fetched ONLY when the tab is opened
 *      (capability-driven sub-tabs; copiers is aggregate-only).
 *   4. Timeframe lazy — query key includes tf; switching fetches just
 *      the newly selected timeframe.
 */

import { useMemo, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useTraderCore } from '@/lib/hooks/useTraderCore'
import { useBotHeader } from '@/lib/hooks/useBotHeader'
import { useTraderRecords, useCopierAggregate } from '@/lib/hooks/useTraderRecords'
import { PeriodSelector, type Period } from '@/app/components/trader/performance/PeriodSelector'
import MetricGrid from './MetricGrid'
import SignalChips from './SignalChips'
import CoreCharts from './CoreCharts'
import ModuleDegraded from './ModuleDegraded'
import RecordsTable, { type RecordColumn } from './RecordsTable'
import CopierAggregatePanel from './CopierAggregatePanel'
import BotHeaderCard from './BotHeaderCard'
import ProvenanceFooter from '@/app/components/common/ProvenanceFooter'
import type {
  RecordKind,
  ServingTimeframe,
  SourceCapability,
  TraderFirstScreen,
} from '@/lib/data/serving/types'

const RECORD_COLUMNS: Record<Exclude<RecordKind, 'copiers'>, RecordColumn[]> = {
  positions: [
    { key: 'symbol', i18nKey: 'colSymbol' },
    { key: 'side', i18nKey: 'colSide' },
    { key: 'leverage', i18nKey: 'colLeverage', format: 'number', align: 'right' },
    { key: 'size', i18nKey: 'colSize', format: 'number', align: 'right' },
    { key: 'entry_price', i18nKey: 'colEntryPrice', format: 'number', align: 'right' },
    { key: 'mark_price', i18nKey: 'colMarkPrice', format: 'number', align: 'right' },
    { key: 'unrealized_pnl', i18nKey: 'colUnrealizedPnl', format: 'money', align: 'right' },
  ],
  position_history: [
    { key: 'symbol', i18nKey: 'colSymbol' },
    { key: 'side', i18nKey: 'colSide' },
    { key: 'leverage', i18nKey: 'colLeverage', format: 'number', align: 'right' },
    { key: 'entry_price', i18nKey: 'colEntryPrice', format: 'number', align: 'right' },
    { key: 'exit_price', i18nKey: 'colExitPrice', format: 'number', align: 'right' },
    { key: 'realized_pnl', i18nKey: 'colRealizedPnl', format: 'money', align: 'right' },
    { key: 'opened_at', i18nKey: 'colOpenedAt', format: 'datetime' },
    { key: 'closed_at', i18nKey: 'colClosedAt', format: 'datetime' },
  ],
  orders: [
    { key: 'ts', i18nKey: 'colTime', format: 'datetime' },
    { key: 'kind', i18nKey: 'colType' },
    { key: 'symbol', i18nKey: 'colSymbol' },
    { key: 'side', i18nKey: 'colSide' },
    { key: 'price', i18nKey: 'colPrice', format: 'number', align: 'right' },
    { key: 'qty', i18nKey: 'colQty', format: 'number', align: 'right' },
  ],
  transfers: [
    { key: 'ts', i18nKey: 'colTime', format: 'datetime' },
    { key: 'direction', i18nKey: 'colDirection' },
    { key: 'asset', i18nKey: 'colAsset' },
    { key: 'amount', i18nKey: 'colAmount', format: 'money', align: 'right' },
  ],
}

const KIND_TAB_I18N: Record<RecordKind, string> = {
  positions: 'tabPositions',
  position_history: 'tabPositionHistory',
  orders: 'tabOrders',
  transfers: 'tabTransfers',
  copiers: 'tabCopiers',
}

function ModuleSkeleton({ height }: { height: number }) {
  return (
    <div
      style={{
        height,
        borderRadius: tokens.radius.lg,
        background:
          'linear-gradient(90deg, var(--color-bg-tertiary) 25%, var(--color-bg-secondary) 50%, var(--color-bg-tertiary) 75%)',
        backgroundSize: '200% 100%',
        animation: 'servingPulse 1.4s ease infinite',
      }}
    />
  )
}

/** One heavy record tab — own component so its hook mounts lazily. */
function RecordKindPanel({
  source,
  exchangeTraderId,
  kind,
  tf,
  exchangeName,
}: {
  source: string
  exchangeTraderId: string
  kind: Exclude<RecordKind, 'copiers'>
  tf: ServingTimeframe
  exchangeName?: string
}) {
  const records = useTraderRecords({ source, exchangeTraderId, kind, tf, enabled: true })

  if (records.isLoading) return <ModuleSkeleton height={160} />
  if (records.error) return <ModuleDegraded onRetry={() => records.refetch()} />
  if (records.isPendingUpstream && records.rows.length === 0) {
    return <ModuleDegraded onRetry={() => records.refetch()} />
  }

  return (
    <Box>
      <RecordsTable
        columns={RECORD_COLUMNS[kind]}
        rows={records.rows}
        hasNextPage={records.hasNextPage}
        isFetchingNextPage={records.isFetchingNextPage}
        onLoadMore={() => records.fetchNextPage()}
      />
      {records.provenance && (
        <ProvenanceFooter provenance={records.provenance} exchangeName={exchangeName} />
      )}
    </Box>
  )
}

function CopiersPanel({
  source,
  exchangeTraderId,
  exchangeName,
}: {
  source: string
  exchangeTraderId: string
  exchangeName?: string
}) {
  const { aggregate, isLoading, refetch } = useCopierAggregate({
    source,
    exchangeTraderId,
    enabled: true,
  })
  if (isLoading) return <ModuleSkeleton height={160} />
  return (
    <CopierAggregatePanel
      aggregate={aggregate}
      isLoading={isLoading}
      exchangeName={exchangeName}
      onRetry={() => refetch()}
    />
  )
}

export interface ServingProfilePanelProps {
  firstScreen: TraderFirstScreen
  capability: SourceCapability | null
}

export default function ServingProfilePanel({ firstScreen, capability }: ServingProfilePanelProps) {
  const { t } = useLanguage()
  const { source, exchangeTraderId } = firstScreen

  const [period, setPeriod] = useState<Period>('90D')
  const [inceptionSelected, setInceptionSelected] = useState(false)
  const tf: ServingTimeframe = inceptionSelected
    ? 'inception'
    : (Number(period.replace('D', '')) as 7 | 30 | 90)

  const core = useTraderCore({ source, exchangeTraderId, tf })

  // Bot profile header (spec §1.3) — only fetched for bot traders.
  const isBot = firstScreen.traderKind === 'bot'
  const { bot } = useBotHeader({ source, exchangeTraderId, enabled: isBot })

  // 独家信号 (spec §12.2/§12.3): numeric extras the registry knows (nav —
  // BitMart/Gate net asset value) are promoted into the stats grid; the
  // qualitative ones (style labels, risk rating, last liquidation) render
  // as SignalChips. Both NULL-collapse when the source has no signal.
  const gridStats = useMemo<Record<string, number | string | null>>(() => {
    if (!core.modules) return {}
    const merged = { ...core.modules.stats }
    for (const key of ['nav', 'risk_rating'] as const) {
      if (merged[key] !== undefined) continue
      const raw = core.modules.extras[key]
      const n = typeof raw === 'string' ? Number(raw) : raw
      if (typeof n === 'number' && Number.isFinite(n)) merged[key] = n
    }
    return merged
  }, [core.modules])

  // Dormant trader (e.g. Bitget "*不活跃"): every core metric is 0 and the
  // series is flat. Show one honest line instead of a grid of 0.00% that
  // reads like a render failure. We do NOT fabricate data.
  const isDormant = useMemo(() => {
    if (!core.modules) return false
    const core_keys = ['roi', 'pnl', 'win_rate', 'total_positions', 'aum'] as const
    const allZero = core_keys.every((k) => {
      const v = gridStats[k]
      return v === undefined || v === null || Number(v) === 0
    })
    return allZero && core_keys.some((k) => gridStats[k] !== undefined)
  }, [core.modules, gridStats])

  // Record sub-tabs: capability-driven; only opened tabs ever fetch.
  const kinds: RecordKind[] = capability
    ? (Object.keys(KIND_TAB_I18N) as RecordKind[]).filter((k) => capability.surfaces[k])
    : []
  // Auto-select a record tab so the table (with its keyset "load more")
  // renders immediately on open. A null default made the whole records area
  // show an empty placeholder until the user happened to click a tab — read as
  // "the data and paging are gone". Prefer the data-rich CLOSED-trade history
  // as the landing tab: open `positions` is frequently empty (trader flat right
  // now) so defaulting to it still looks dataless; position_history is the
  // long, paginated record the user remembers. Tabs still display in the
  // conventional order; only the default selection is reordered. Once the user
  // clicks, `activeKind` takes over.
  const AUTO_SELECT_ORDER: RecordKind[] = [
    'position_history',
    'positions',
    'orders',
    'transfers',
    'copiers',
  ]
  const [activeKind, setActiveKind] = useState<RecordKind | null>(null)
  const defaultKind = AUTO_SELECT_ORDER.find((k) => kinds.includes(k)) ?? kinds[0] ?? null
  const effectiveKind: RecordKind | null = activeKind ?? defaultKind

  const availability = capability
    ? {
        '7D': capability.timeframes['7'],
        '30D': capability.timeframes['30'],
        '90D': capability.timeframes['90'],
      }
    : undefined

  const showInception = Boolean(capability?.inceptionTf && firstScreen.traderKind === 'bot')

  return (
    <Box style={{ marginTop: tokens.spacing[4] }}>
      <style>{`@keyframes servingPulse { 0% { background-position: 200% 0 } 100% { background-position: -200% 0 } }`}</style>

      {/* ── Bot header (spec §1.3): strategy/pair/runtime/profit-share/owner ── */}
      {isBot && bot && <BotHeaderCard bot={bot} style={{ marginBottom: tokens.spacing[3] }} />}

      {/* ── Core modules (spec §2.4-2): one request per timeframe ── */}
      <PeriodSelector
        period={period}
        onPeriodChange={(p) => {
          setInceptionSelected(false)
          setPeriod(p)
        }}
        source={source}
        lastUpdated={core.modules?.provenance.asOf}
        availability={availability}
        showInception={showInception}
        inceptionSelected={inceptionSelected}
        onInceptionSelect={() => setInceptionSelected(true)}
      />

      {core.modules ? (
        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
          {core.isPendingUpstream && (
            <Text size="xs" color="tertiary" style={{ opacity: 0.7 }}>
              {t('moduleDataPending')}
            </Text>
          )}
          <SignalChips source={source} extras={core.modules.extras} />
          {isDormant && (
            <Text size="sm" color="tertiary">
              {t('traderDormantForPeriod')}
            </Text>
          )}
          <MetricGrid
            stats={gridStats}
            capabilityMetrics={[
              ...(capability?.metrics ?? Object.keys(core.modules.stats)),
              // Extras-sourced metrics aren't in the capability RPC's
              // trader_stats column scan — allow them when present.
              'nav',
              'risk_rating',
            ]}
            currency={core.modules.currency}
          />
          <CoreCharts series={core.modules.series} timeframe={tf} />
          <ProvenanceFooter
            provenance={core.modules.provenance}
            exchangeName={capability?.exchangeName}
          />
        </Box>
      ) : core.isDegraded ? (
        <ModuleDegraded onRetry={() => core.refetch()} />
      ) : (
        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
          <ModuleSkeleton height={120} />
          <ModuleSkeleton height={220} />
        </Box>
      )}

      {/* ── Heavy record tabs (spec §2.4-3): lazy, only if opened ── */}
      {kinds.length > 0 && (
        <Box style={{ marginTop: tokens.spacing[6] }}>
          <Box
            style={{
              display: 'flex',
              gap: tokens.spacing[1],
              borderBottom: '1px solid ' + tokens.colors.border.primary,
              marginBottom: tokens.spacing[4],
              overflowX: 'auto',
            }}
          >
            {kinds.map((kind) => (
              <button
                key={kind}
                onClick={() => setActiveKind(kind)}
                aria-pressed={effectiveKind === kind}
                style={{
                  padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                  border: 'none',
                  background: 'transparent',
                  borderBottom:
                    effectiveKind === kind
                      ? '2px solid var(--color-accent-primary, #6366f1)'
                      : '2px solid transparent',
                  color:
                    effectiveKind === kind
                      ? tokens.colors.text.primary
                      : tokens.colors.text.secondary,
                  fontSize: 13,
                  fontWeight: effectiveKind === kind ? 600 : 400,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                {t(KIND_TAB_I18N[kind])}
              </button>
            ))}
          </Box>

          {effectiveKind === 'copiers' ? (
            <CopiersPanel
              source={source}
              exchangeTraderId={exchangeTraderId}
              exchangeName={capability?.exchangeName}
            />
          ) : effectiveKind ? (
            <RecordKindPanel
              key={effectiveKind}
              source={source}
              exchangeTraderId={exchangeTraderId}
              kind={effectiveKind}
              tf={tf}
              exchangeName={capability?.exchangeName}
            />
          ) : (
            <Text size="xs" color="tertiary" style={{ opacity: 0.6 }}>
              {t('recordsEmpty')}
            </Text>
          )}
        </Box>
      )}
    </Box>
  )
}
