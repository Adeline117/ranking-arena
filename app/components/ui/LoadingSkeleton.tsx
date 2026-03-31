/**
 * Unified LoadingSkeleton component
 * Wraps the existing Skeleton variants from @/app/components/ui/Skeleton
 * with a simple variant/type + count API.
 */

import { tokens } from '@/lib/design-tokens'
import {
  SkeletonCard,
  TableSkeleton,
  ListSkeleton,
  RankingSkeleton,
  TraderCardSkeleton,
  SkeletonText,
} from './Skeleton'

type SkeletonVariant = 'card' | 'table' | 'list' | 'detail' | 'text' | 'trader' | 'ranking'

type LoadingSkeletonProps = {
  /** Preferred prop name */
  variant?: SkeletonVariant
  /** Legacy alias for variant (DataStateWrapper compat) */
  type?: SkeletonVariant
  count?: number
}

export default function LoadingSkeleton({ variant, type, count = 1 }: LoadingSkeletonProps) {
  const v = variant ?? type ?? 'card'

  switch (v) {
    case 'table':
      return <TableSkeleton rows={count > 1 ? count : 5} columns={5} />

    case 'list':
      return <ListSkeleton count={count} />

    case 'detail':
    case 'trader':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
          {Array.from({ length: count }).map((_, i) => (
            <TraderCardSkeleton key={i} />
          ))}
        </div>
      )

    case 'ranking':
      return <RankingSkeleton rows={count > 1 ? count : 10} />

    case 'text':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
          {Array.from({ length: count }).map((_, i) => (
            <SkeletonText key={i} lines={3} />
          ))}
        </div>
      )

    case 'card':
    default:
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
          {Array.from({ length: count }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      )
  }
}
