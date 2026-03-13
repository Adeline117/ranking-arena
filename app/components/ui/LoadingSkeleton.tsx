/**
 * Unified LoadingSkeleton component
 * Wraps the existing Skeleton variants from @/app/components/ui/Skeleton
 * with a simple variant + count API.
 */

import { tokens } from '@/lib/design-tokens'
import {
  SkeletonCard,
  TableSkeleton,
  ListSkeleton,
  TraderCardSkeleton,
  SkeletonText,
} from './Skeleton'

type LoadingSkeletonProps = {
  variant?: 'card' | 'table' | 'list' | 'detail' | 'text'
  count?: number
}

export default function LoadingSkeleton({ variant = 'card', count = 1 }: LoadingSkeletonProps) {
  switch (variant) {
    case 'table':
      return <TableSkeleton rows={count > 1 ? count : 5} columns={5} />

    case 'list':
      return <ListSkeleton count={count} />

    case 'detail':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
          {Array.from({ length: count }).map((_, i) => (
            <TraderCardSkeleton key={i} />
          ))}
        </div>
      )

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
