import { RankingSkeleton } from '@/app/components/ui/Skeleton'

export default function Loading() {
  return (
    <div style={{ minHeight: 800 }}>
      <RankingSkeleton />
    </div>
  )
}
