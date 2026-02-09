import { tokens } from '@/lib/design-tokens'
export default function Loading() {
  return (
    <div style={{ minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div className="skeleton" style={{ width: 600, maxWidth: '100%', height: 400, borderRadius: tokens.radius.lg }} />
    </div>
  )
}
