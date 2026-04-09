import { RankingSkeleton } from '@/app/components/ui/Skeleton'

export default function Loading() {
  return (
    <div style={{ minHeight: 600 }}>
      <RankingSkeleton />
    </div>
  )
}
