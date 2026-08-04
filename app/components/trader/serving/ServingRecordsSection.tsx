'use client'

/**
 * Records section (spec §2.4-3) — the capability-driven record sub-tabs:
 * current positions / position history / orders / transfers / copiers, each with
 * keyset "load more" pagination (RecordsTable) or the aggregate copier panel.
 *
 * Extracted from ServingProfilePanel so BOTH the escape-hatch panel AND the
 * DEFAULT three-tab profile can render it — previously orders/transfers/copiers
 * were only wired into the ?threetab=0 escape hatch, so captured records were
 * invisible to normal users (M1 display-wiring fix). Single source of truth for
 * RECORD_COLUMNS / kind tabs. Every sub-tab NULL-collapses + lazy-mounts (its
 * hook only fires when the tab is opened).
 */

import { useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useTraderRecords, useCopierAggregate } from '@/lib/hooks/useTraderRecords'
import RecordsTable, { type RecordColumn } from './RecordsTable'
import CopierAggregatePanel from './CopierAggregatePanel'
import HistoryCompletenessNotice from './HistoryCompletenessNotice'
import ModuleDegraded from './ModuleDegraded'
import RecordProvenanceFooter from '@/app/components/common/RecordProvenanceFooter'
import type { RecordKind, ServingTimeframe, SourceCapability } from '@/lib/data/serving/types'

export const RECORD_COLUMNS: Record<Exclude<RecordKind, 'copiers'>, RecordColumn[]> = {
  positions: [
    { key: 'symbol', i18nKey: 'colSymbol' },
    { key: 'side', i18nKey: 'colSide' },
    { key: 'margin_mode', i18nKey: 'colMarginMode' },
    { key: 'leverage', i18nKey: 'colLeverage', format: 'number', align: 'right' },
    { key: 'size', i18nKey: 'colSize', format: 'number', align: 'right' },
    { key: 'entry_price', i18nKey: 'colEntryPrice', format: 'number', align: 'right' },
    { key: 'mark_price', i18nKey: 'colMarkPrice', format: 'number', align: 'right' },
    { key: 'notional', i18nKey: 'colNotional', format: 'money', align: 'right' },
    { key: 'margin', i18nKey: 'colMargin', format: 'money', align: 'right' },
    { key: 'unrealized_pnl', i18nKey: 'colUnrealizedPnl', format: 'money', align: 'right' },
    { key: 'roe', i18nKey: 'colRoe', format: 'pct', align: 'right' },
  ],
  position_history: [
    { key: 'symbol', i18nKey: 'colSymbol' },
    { key: 'side', i18nKey: 'colSide' },
    { key: 'margin_mode', i18nKey: 'colMarginMode' },
    { key: 'leverage', i18nKey: 'colLeverage', format: 'number', align: 'right' },
    { key: 'entry_price', i18nKey: 'colEntryPrice', format: 'number', align: 'right' },
    { key: 'exit_price', i18nKey: 'colExitPrice', format: 'number', align: 'right' },
    { key: 'max_open_interest', i18nKey: 'colMaxOpenInterest', format: 'number', align: 'right' },
    { key: 'realized_pnl', i18nKey: 'colRealizedPnl', format: 'money', align: 'right' },
    { key: 'roi', i18nKey: 'colRoi', format: 'pct', align: 'right' },
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
    { key: 'notional', i18nKey: 'colNotional', format: 'money', align: 'right' },
    { key: 'realized_pnl', i18nKey: 'colRealizedPnl', format: 'money', align: 'right' },
  ],
  transfers: [
    { key: 'ts', i18nKey: 'colTime', format: 'datetime' },
    { key: 'direction', i18nKey: 'colDirection' },
    { key: 'asset', i18nKey: 'colAsset' },
    { key: 'amount', i18nKey: 'colAmount', format: 'money', align: 'right' },
  ],
}

export const KIND_TAB_I18N: Record<RecordKind, string> = {
  positions: 'tabPositions',
  position_history: 'tabPositionHistory',
  orders: 'tabOrders',
  transfers: 'tabTransfers',
  copiers: 'tabCopiers',
}

/** Landing-tab preference: the long paginated history reads as "rich" on open. */
const AUTO_SELECT_ORDER: RecordKind[] = [
  'position_history',
  'positions',
  'orders',
  'transfers',
  'copiers',
]

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
      {kind === 'position_history' && (
        <HistoryCompletenessNotice completeness={records.completeness} />
      )}
      <RecordsTable
        columns={RECORD_COLUMNS[kind]}
        rows={records.rows}
        hasNextPage={records.hasNextPage}
        isFetchingNextPage={records.isFetchingNextPage}
        onLoadMore={() => records.fetchNextPage()}
        emptyKey={
          kind === 'position_history' &&
          records.completeness &&
          records.completeness.state !== 'complete'
            ? 'historyPreviewEmptyTitle'
            : undefined
        }
      />
      {records.provenance && (
        <RecordProvenanceFooter provenance={records.provenance} exchangeName={exchangeName} />
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

export interface ServingRecordsSectionProps {
  source: string
  exchangeTraderId: string
  capability: SourceCapability | null
  tf: ServingTimeframe
  exchangeName?: string
  /** Kinds already rendered elsewhere on the host (e.g. the default three-tab's
   *  Portfolio=positions + Stats=position_history) — hidden here to avoid dupes. */
  excludeKinds?: RecordKind[]
}

/**
 * Capability-driven record sub-tabs. Returns null when the source exposes no
 * record surfaces (NULL-collapse). Safe to mount unconditionally.
 */
export default function ServingRecordsSection({
  source,
  exchangeTraderId,
  capability,
  tf,
  exchangeName,
  excludeKinds,
}: ServingRecordsSectionProps) {
  const { t } = useLanguage()
  const exclude = new Set(excludeKinds ?? [])
  const kinds: RecordKind[] = capability
    ? (Object.keys(KIND_TAB_I18N) as RecordKind[]).filter(
        (k) => capability.surfaces[k] && !exclude.has(k)
      )
    : []
  const selectionScope = JSON.stringify([source, exchangeTraderId, kinds])
  const [activeSelection, setActiveSelection] = useState<{
    scope: string
    kind: RecordKind
  } | null>(null)
  const defaultKind = AUTO_SELECT_ORDER.find((k) => kinds.includes(k)) ?? kinds[0] ?? null
  // A selection belongs to one exact trader + capability surface. Subject
  // switches and capability shrinkage must use the new subject's default in
  // the same render; an old, still-mounted tab may never drive its query.
  const effectiveKind: RecordKind | null =
    activeSelection?.scope === selectionScope && kinds.includes(activeSelection.kind)
      ? activeSelection.kind
      : defaultKind

  if (kinds.length === 0) return null

  return (
    <Box style={{ marginTop: tokens.spacing[6] }}>
      <style>{`@keyframes servingPulse { 0% { background-position: 200% 0 } 100% { background-position: -200% 0 } }`}</style>
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
            type="button"
            onClick={() => setActiveSelection({ scope: selectionScope, kind })}
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
                effectiveKind === kind ? tokens.colors.text.primary : tokens.colors.text.secondary,
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
          key={`${source}:${exchangeTraderId}:copiers`}
          source={source}
          exchangeTraderId={exchangeTraderId}
          exchangeName={exchangeName}
        />
      ) : effectiveKind ? (
        <RecordKindPanel
          key={`${source}:${exchangeTraderId}:${effectiveKind}`}
          source={source}
          exchangeTraderId={exchangeTraderId}
          kind={effectiveKind}
          tf={tf}
          exchangeName={exchangeName}
        />
      ) : (
        <Text size="xs" color="tertiary" style={{ opacity: 0.6 }}>
          {t('recordsEmpty')}
        </Text>
      )}
    </Box>
  )
}
