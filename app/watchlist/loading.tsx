import LoadingSkeleton from '@/app/components/ui/LoadingSkeleton'

export default function Loading() {
  return (
    <div style={{ maxWidth: 1000, margin: '0 auto', padding: '80px 16px 60px' }}>
      <LoadingSkeleton variant="list" count={5} />
    </div>
  )
}
