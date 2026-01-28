'use client'

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { RankingSkeleton } from '../ui/Skeleton'
import { RankingBadge } from '../icons'
import { Box, Text } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'
import type { Trader } from './RankingTable'

/**
 * 紧凑版排行榜 - 用于侧边栏
 * 只显示：排名、交易员ID、ROI (90D)
 */
export default function RankingTableCompact(props: {
  traders: Trader[]
  loading: boolean
  loggedIn: boolean
}) {
  const { traders, loading } = props
  const { language } = useLanguage()

  // 按90天ROI排序（固定）
  const sortedTraders = [...traders].sort((a, b) => b.roi - a.roi)

  return (
    <Box
      bg="secondary"
      p={0}
      radius="none"
      border="none"
    >
      {/* Header - 最小化 */}
      <Box
        style={{
          display: 'grid',
          gridTemplateColumns: '40px minmax(80px, 1fr) 80px', // Rank | ID | ROI (90D)
          gap: tokens.spacing[2],
          padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
          borderBottom: `1px solid ${tokens.colors.border.primary}`,
        }}
      >
        <Text size="xs" weight="bold" color="tertiary" style={{ textAlign: 'center', whiteSpace: 'nowrap' }}>
          {language === 'zh' ? '排名' : 'Rank'}
        </Text>
        <Text size="xs" weight="bold" color="tertiary" style={{ whiteSpace: 'nowrap' }}>
          {language === 'zh' ? '交易员' : 'Trader'}
        </Text>
        <Text size="xs" weight="bold" color="tertiary" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
          ROI
        </Text>
      </Box>

      {loading ? (
        <RankingSkeleton />
      ) : sortedTraders.length === 0 ? (
        <Box
          style={{
            color: tokens.colors.text.tertiary,
            padding: `${tokens.spacing[6]} ${tokens.spacing[3]}`,
            textAlign: 'center',
            fontSize: tokens.typography.fontSize.sm,
          }}
        >
          {language === 'zh' ? '暂无交易者数据' : 'No trader data'}
        </Box>
      ) : (
        <Box style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {sortedTraders.map((t, idx) => {
            const rank = idx + 1
            const traderHandle = t.handle || t.id
            const href = `/trader/${encodeURIComponent(traderHandle)}`

            return (
              <Link
                key={t.id}
                href={href}
                style={{ textDecoration: 'none' }}
              >
                <Box
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '40px minmax(80px, 1fr) 80px',
                    alignItems: 'center',
                    gap: tokens.spacing[2],
                    padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                    borderBottom: `1px solid ${tokens.colors.border.primary}`,
                    cursor: 'pointer',
                    background: tokens.colors.bg.primary,
                    transition: `background-color ${tokens.transition.fast}`,
                  }}
                  onMouseEnter={(e: React.MouseEvent<HTMLTableRowElement>) => {
                    e.currentTarget.style.background = tokens.colors.bg.secondary
                  }}
                  onMouseLeave={(e: React.MouseEvent<HTMLTableRowElement>) => {
                    e.currentTarget.style.background = tokens.colors.bg.primary
                  }}
                >
                  {/* 排名 */}
                  <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {rank <= 3 ? (
                      <RankingBadge rank={rank as 1 | 2 | 3} size={20} />
                    ) : (
                      <Text size="xs" weight="bold" color="tertiary">
                        #{rank}
                      </Text>
                    )}
                  </Box>

                  {/* 交易员ID */}
                  <Text size="sm" weight="black" style={{ color: tokens.colors.text.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {traderHandle}
                  </Text>

                  {/* ROI (90D) - 使用颜色表达，视觉权重高 */}
                  <Text
                    size="sm"
                    weight="black"
                    style={{
                      textAlign: 'right',
                      color: t.roi >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error,
                    }}
                  >
                    {t.roi >= 0 ? '+' : ''}
                    {t.roi.toFixed(2)}%
                  </Text>
                </Box>
              </Link>
            )
          })}
        </Box>
      )}
    </Box>
  )
}


