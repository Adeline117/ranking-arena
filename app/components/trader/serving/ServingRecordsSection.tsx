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

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
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
    { key: 'amount', i18nKey: 'colAmount', format: 'asset_quantity', align: 'right' },
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

const UNBOUND_HISTORY = {
  state: 'unknown' as const,
  reason: 'history_evidence_not_bound' as const,
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

function RecordsRefreshFailureNotice({
  isRetrying,
  onRetry,
}: {
  isRetrying: boolean
  onRetry: () => void
}) {
  const { t } = useLanguage()
  return (
    <Box
      role="status"
      aria-live="polite"
      aria-atomic="true"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: tokens.spacing[2],
        padding: tokens.spacing[3],
        marginBottom: tokens.spacing[3],
        borderRadius: tokens.radius.md,
        border: `1px solid ${tokens.colors.border.primary}`,
        background: tokens.colors.bg.tertiary,
      }}
    >
      <Text size="sm" style={{ color: tokens.colors.accent.warning }}>
        {t('recordsRefreshFailed')}
      </Text>
      <button
        type="button"
        onClick={onRetry}
        disabled={isRetrying}
        style={{
          minHeight: tokens.touchTarget.min,
          padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
          borderRadius: tokens.radius.md,
          border: `1px solid ${tokens.colors.border.primary}`,
          background: tokens.colors.bg.primary,
          color: tokens.colors.text.primary,
          fontSize: tokens.typography.fontSize.sm,
          cursor: isRetrying ? 'wait' : 'pointer',
          opacity: isRetrying ? 0.6 : 1,
        }}
      >
        {isRetrying ? t('loading') : t('moduleRetry')}
      </button>
    </Box>
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
  if (records.isInitialError) return <ModuleDegraded onRetry={() => records.refetch()} />
  if (records.isPendingUpstream && records.rows.length === 0) {
    return <ModuleDegraded onRetry={() => records.refetch()} />
  }
  return (
    <Box>
      <HistoryCompletenessNotice
        completeness={kind === 'positions' ? null : (records.completeness ?? UNBOUND_HISTORY)}
      />
      {records.isRefetchError && (
        <RecordsRefreshFailureNotice
          isRetrying={records.isRefetching}
          onRetry={() => void records.refetch()}
        />
      )}
      <RecordsTable
        columns={RECORD_COLUMNS[kind]}
        rows={records.rows}
        hasNextPage={records.hasNextPage}
        isFetchingNextPage={records.isFetchingNextPage}
        hasLoadMoreError={records.isFetchNextPageError}
        onLoadMore={() => void records.fetchNextPage()}
        emptyKey={
          kind !== 'positions' && records.completeness?.state !== 'complete'
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
  const { t } = useLanguage()
  const { aggregate, isLoading, isPendingUpstream, refetch } = useCopierAggregate({
    source,
    exchangeTraderId,
    enabled: true,
  })
  if (isLoading || isPendingUpstream) {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-label={t('loading')}
        data-copier-state={isLoading ? 'loading' : 'pending'}
      >
        <ModuleSkeleton height={160} />
        <Text
          size="sm"
          color="tertiary"
          style={{ display: 'block', marginTop: tokens.spacing[2], textAlign: 'center' }}
        >
          {t('moduleDataPending')}
        </Text>
      </div>
    )
  }
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
  const tabsId = useId()
  const panelId = `${tabsId}-panel`
  const tablistRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef<Map<RecordKind, HTMLButtonElement>>(new Map())
  const tablistOwnedFocus = useRef(false)
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

  // Remember whether the last explicit focus target belongs to this tablist.
  // This survives removal of a focused tab during capability shrinkage, while
  // focus moving to an account switcher or any other control clears ownership.
  useEffect(() => {
    const handleFocus = (event: FocusEvent) => {
      tablistOwnedFocus.current = Boolean(
        event.target instanceof Node && tablistRef.current?.contains(event.target)
      )
    }
    const handleWindowBlur = () => {
      tablistOwnedFocus.current = false
    }
    document.addEventListener('focusin', handleFocus)
    window.addEventListener('blur', handleWindowBlur)
    return () => {
      document.removeEventListener('focusin', handleFocus)
      window.removeEventListener('blur', handleWindowBlur)
    }
  }, [])

  // If a subject/capability update changes the selected tab while this list
  // owned focus, move focus to the new roving tab after the DOM is committed.
  useLayoutEffect(() => {
    if (tablistOwnedFocus.current && effectiveKind) {
      tabRefs.current.get(effectiveKind)?.focus()
    }
  }, [effectiveKind, selectionScope])

  if (kinds.length === 0) return null

  return (
    <Box style={{ marginTop: tokens.spacing[6] }}>
      <style>{`@keyframes servingPulse { 0% { background-position: 200% 0 } 100% { background-position: -200% 0 } }`}</style>
      <Box
        ref={tablistRef}
        role="tablist"
        aria-label={t('recordsTabs')}
        aria-orientation="horizontal"
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
            ref={(element) => {
              if (element) tabRefs.current.set(kind, element)
              else tabRefs.current.delete(kind)
            }}
            type="button"
            id={`${tabsId}-tab-${kind}`}
            role="tab"
            onClick={() => setActiveSelection({ scope: selectionScope, kind })}
            onKeyDown={(event) => {
              const currentIndex = kinds.indexOf(kind)
              let nextIndex: number | null = null
              if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % kinds.length
              else if (event.key === 'ArrowLeft') {
                nextIndex = (currentIndex - 1 + kinds.length) % kinds.length
              } else if (event.key === 'Home') nextIndex = 0
              else if (event.key === 'End') nextIndex = kinds.length - 1
              if (nextIndex === null) return

              event.preventDefault()
              const nextKind = kinds[nextIndex]
              setActiveSelection({ scope: selectionScope, kind: nextKind })
              tabRefs.current.get(nextKind)?.focus()
            }}
            aria-selected={effectiveKind === kind}
            aria-controls={panelId}
            tabIndex={effectiveKind === kind ? 0 : -1}
            style={{
              padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
              minHeight: tokens.touchTarget.min,
              border: 'none',
              background: 'transparent',
              borderBottom:
                effectiveKind === kind
                  ? `2px solid ${tokens.colors.accent.primary}`
                  : '2px solid transparent',
              color:
                effectiveKind === kind ? tokens.colors.text.primary : tokens.colors.text.secondary,
              fontSize: tokens.typography.fontSize.sm,
              fontWeight:
                effectiveKind === kind
                  ? tokens.typography.fontWeight.semibold
                  : tokens.typography.fontWeight.normal,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {t(KIND_TAB_I18N[kind])}
          </button>
        ))}
      </Box>

      {effectiveKind ? (
        <Box
          key={`${source}:${exchangeTraderId}:${effectiveKind}`}
          id={panelId}
          role="tabpanel"
          aria-labelledby={`${tabsId}-tab-${effectiveKind}`}
          tabIndex={0}
        >
          {effectiveKind === 'copiers' ? (
            <CopiersPanel
              source={source}
              exchangeTraderId={exchangeTraderId}
              exchangeName={exchangeName}
            />
          ) : (
            <RecordKindPanel
              source={source}
              exchangeTraderId={exchangeTraderId}
              kind={effectiveKind}
              tf={tf}
              exchangeName={exchangeName}
            />
          )}
        </Box>
      ) : (
        <Text size="xs" color="tertiary" style={{ opacity: 0.6 }}>
          {t('recordsEmpty')}
        </Text>
      )}
    </Box>
  )
}
