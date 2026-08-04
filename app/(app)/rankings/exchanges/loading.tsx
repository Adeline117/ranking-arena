import { Box } from '@/app/components/base'
import { Skeleton } from '@/app/components/ui/Skeleton'
import { tokens } from '@/lib/design-tokens'
import { t } from '@/lib/i18n'

const METRIC_COLUMNS = 7
const ROWS = 9

function ExchangeTableSkeletonRow({ header = false }: { header?: boolean }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(190px, 1.6fr) repeat(7, minmax(88px, 1fr))',
        alignItems: 'center',
        gap: tokens.spacing[3],
        minWidth: 980,
        minHeight: header ? 60 : 52,
        padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
        borderBottom: '1px solid var(--color-border-primary)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
        {!header && <Skeleton width={20} height={20} />}
        <Skeleton width={header ? 72 : 112} height={header ? 12 : 14} />
      </div>
      {Array.from({ length: METRIC_COLUMNS }).map((_, index) => (
        <Skeleton
          key={index}
          width={index === METRIC_COLUMNS - 1 ? 64 : 52}
          height={header ? 12 : 14}
          style={{ justifySelf: 'end' }}
        />
      ))}
    </div>
  )
}

export default function ExchangeRankingsLoading() {
  return (
    <Box role="status" aria-busy="true" aria-label={t('loadingSkeleton')}>
      <div aria-hidden="true">
        <div
          className="exr-loading-header"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: tokens.spacing[3],
            marginBottom: tokens.spacing[4],
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
            <Skeleton width={220} height={28} />
            <Skeleton width={300} height={14} style={{ maxWidth: '78vw' }} />
          </div>
          <div style={{ display: 'flex', gap: tokens.spacing[1] }}>
            {Array.from({ length: 3 }).map((_, index) => (
              <Skeleton
                key={index}
                className="exr-loading-timeframe"
                width={52}
                height={tokens.touchTarget.min}
              />
            ))}
          </div>
        </div>

        <div
          className="exr-loading-table"
          style={{
            overflow: 'hidden',
            border: '1px solid var(--color-border-primary)',
            borderRadius: tokens.radius.lg,
            background: 'var(--color-bg-secondary)',
          }}
        >
          <ExchangeTableSkeletonRow header />
          {Array.from({ length: ROWS }).map((_, index) => (
            <ExchangeTableSkeletonRow key={index} />
          ))}
        </div>
      </div>
    </Box>
  )
}
