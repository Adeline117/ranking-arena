'use client'

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { RankingSkeleton } from '../UI/Skeleton'
import { RankingBadge } from '../Icons'
import { Box, Text } from '../Base'

export interface Trader {
  id: string
  handle: string | null
  roi: number // 90天ROI（固定）
  win_rate: number
  followers: number
  source?: string // 数据来源：binance, bybit, okx等
}

/**
 * 排行榜页面 - 极度克制，只解决"谁最强"的问题
 * 只保留：排名、交易员ID、90天ROI、胜率、关注者数量
 */
export default function RankingTable(props: {
  traders: Trader[]
  loading: boolean
  loggedIn: boolean
  onSelectTrader?: (t: Trader) => void
}) {
  const { traders, loading, loggedIn } = props

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
          gridTemplateColumns: '60px 1fr 100px 80px 100px', // Rank | ID | ROI (90D) | Win Rate | Followers
          gap: tokens.spacing[4],
          padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
          borderBottom: `1px solid ${tokens.colors.border.primary}`,
        }}
      >
        <Text size="xs" weight="bold" color="tertiary" style={{ textAlign: 'center' }}>
          排名
        </Text>
        <Text size="xs" weight="bold" color="tertiary">
          交易员
        </Text>
        <Text size="xs" weight="bold" color="tertiary" style={{ textAlign: 'right' }}>
          ROI (90D)
        </Text>
        <Text size="xs" weight="bold" color="tertiary" style={{ textAlign: 'right' }}>
          胜率
        </Text>
        <Text size="xs" weight="bold" color="tertiary" style={{ textAlign: 'right' }}>
          关注者
        </Text>
      </Box>

      {loading ? (
        <RankingSkeleton />
      ) : sortedTraders.length === 0 ? (
        <Box
          style={{
            color: tokens.colors.text.tertiary,
            padding: `${tokens.spacing[10]} ${tokens.spacing[3]}`,
            textAlign: 'center',
            fontSize: tokens.typography.fontSize.sm,
          }}
        >
          暂无交易者数据
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
                onClick={(e) => {
                  if (props.onSelectTrader) {
                    e.preventDefault()
                    props.onSelectTrader(t)
                  }
                }}
              >
                <Box
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '60px 1fr 80px 100px 80px 100px',
                    alignItems: 'center',
                    gap: tokens.spacing[4],
                    padding: `${tokens.spacing[3]} ${tokens.spacing[3]}`,
                    borderBottom: `1px solid ${tokens.colors.border.primary}`,
                    cursor: 'pointer',
                    background: tokens.colors.bg.primary,
                    transition: `background-color ${tokens.transition.fast}`,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = tokens.colors.bg.secondary
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = tokens.colors.bg.primary
                  }}
                >
                  {/* 排名 */}
                  <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {rank <= 3 ? (
                      <RankingBadge rank={rank as 1 | 2 | 3} size={24} />
                    ) : (
                      <Text size="sm" weight="bold" color="tertiary">
                        #{rank}
                      </Text>
                    )}
                  </Box>

                  {/* 交易员ID - 唯一可点击的元素，视觉权重最高 */}
                  <Text size="sm" weight="black" style={{ color: tokens.colors.text.primary }}>
                    {traderHandle}
                  </Text>

                  {/* 数据来源 - 中性色，小字 */}
                  <Text size="xs" weight="bold" style={{ textAlign: 'center', color: tokens.colors.text.tertiary, textTransform: 'uppercase' }}>
                    {t.source || '—'}
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

                  {/* 胜率 - 中性色 */}
                  <Text size="sm" weight="bold" style={{ textAlign: 'right', color: tokens.colors.text.secondary }}>
                    {(t.win_rate * 100).toFixed(1)}%
                  </Text>

                  {/* 关注者 - 中性色 */}
                  <Text size="sm" weight="bold" style={{ textAlign: 'right', color: tokens.colors.text.secondary }}>
                    {t.followers.toLocaleString()}
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
