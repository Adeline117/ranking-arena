'use client'

/**
 * Quality Badge Component
 * Shows data quality indicators for trader entries
 * - Missing fields are shown as tooltips
 * - Stale data is indicated
 * - Platform-provided vs. calculated values
 */

interface QualityBadgeProps {
  quality_flags?: Record<string, unknown>
  provenance?: Record<string, unknown>
  compact?: boolean
}

export function QualityBadge({ quality_flags, provenance, compact = true }: QualityBadgeProps) {
  if (!quality_flags || Object.keys(quality_flags).length === 0) return null

  const issues: string[] = []

  if (quality_flags.missing_roi) issues.push('ROI not provided')
  if (quality_flags.missing_pnl) issues.push('PnL not provided')
  if (quality_flags.missing_drawdown) issues.push('Drawdown not provided')
  if (quality_flags.missing_win_rate) issues.push('Win rate not provided')
  if (quality_flags.stale_data) issues.push('Data may be stale')
  if (quality_flags.window_not_supported) issues.push('Window not supported by platform')
  if (quality_flags.platform_default_sort) issues.push('Using platform default sort (not ROI)')
  if (quality_flags.reason) issues.push(String(quality_flags.reason))

  if (issues.length === 0) return null

  if (compact) {
    return (
      <span
        className="inline-flex items-center text-[10px] text-yellow-500/70"
        title={issues.join('; ')}
      >
        <WarningIcon />
      </span>
    )
  }

  return (
    <div className="flex flex-col gap-0.5 mt-1">
      {issues.map((issue, idx) => (
        <span key={idx} className="text-[10px] text-yellow-500/60 flex items-center gap-1">
          <WarningIcon />
          {issue}
        </span>
      ))}
      {provenance?.platform_sorting === 'default' && (
        <span className="text-[10px] text-gray-500 flex items-center gap-1">
          Platform does not support ROI sort
        </span>
      )}
    </div>
  )
}

/**
 * Staleness Indicator
 * Shows how fresh the data is
 */
export function StalenessIndicator({ updatedAt, staleness }: { updatedAt?: string | null; staleness?: boolean }) {
  if (!updatedAt) {
    return (
      <span className="text-[10px] text-gray-500">No data</span>
    )
  }

  const ageMs = Date.now() - new Date(updatedAt).getTime()
  const minutes = Math.floor(ageMs / 60000)
  const hours = Math.floor(minutes / 60)

  let ageText: string
  let color: string

  if (minutes < 60) {
    ageText = `${minutes}m ago`
    color = 'text-green-400'
  } else if (hours < 4) {
    ageText = `${hours}h ago`
    color = 'text-yellow-400'
  } else if (hours < 24) {
    ageText = `${hours}h ago`
    color = 'text-orange-400'
  } else {
    ageText = `${Math.floor(hours / 24)}d ago`
    color = 'text-red-400'
  }

  return (
    <span className={`text-[10px] ${color} ${staleness ? 'opacity-70' : ''}`}>
      {ageText}
    </span>
  )
}

/**
 * Window Not Supported Badge
 */
export function WindowNotSupported({ platform }: { platform: string }) {
  return (
    <span className="text-[10px] text-gray-500 italic" title={`${platform} does not provide this time window`}>
      Not available
    </span>
  )
}

function WarningIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2L1 21h22L12 2zm0 4l7.53 13H4.47L12 6zm-1 4v4h2v-4h-2zm0 6v2h2v-2h-2z" />
    </svg>
  )
}
