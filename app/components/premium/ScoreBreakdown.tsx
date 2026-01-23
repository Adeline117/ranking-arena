'use client'

import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'
import Link from 'next/link'

interface ScoreBreakdownProps {
  arenaScore: number | null
  returnScore: number | null
  drawdownScore: number | null
  stabilityScore: number | null
  source?: string
  percentile?: {
    overall: number
    return: number
    drawdown: number
    stability: number
  }
  isPro: boolean
  onUnlock?: () => void
}

// 锁图标
const LockIcon = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M19 11H5C3.9 11 3 11.9 3 13V20C3 21.1 3.9 22 5 22H19C20.1 22 21 21.1 21 20V13C21 11.9 20.1 11 19 11Z"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M7 11V7C7 4.2 9.2 2 12 2C14.8 2 17 4.2 17 7V11"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    />
    <circle cx="12" cy="16" r="1" fill="currentColor" />
  </svg>
)

// 星星图标
const _StarIcon = ({ size = 10 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
  </svg>
)

// 分数配色
function getScoreColor(score: number | null, max: number): string {
  if (score == null) return 'var(--color-text-tertiary)'
  const ratio = score / max
  if (ratio >= 0.7) return 'var(--color-accent-success)'
  if (ratio >= 0.4) return 'var(--color-accent-warning)'
  return 'var(--color-accent-error)'
}

// 分位描述
function getPercentileLabel(percentile: number, language: string): string {
  if (language === 'en') {
    if (percentile >= 95) return 'Top 5%'
    if (percentile >= 90) return 'Top 10%'
    if (percentile >= 75) return 'Top 25%'
    if (percentile >= 50) return 'Top 50%'
    return `Top ${100 - percentile}%`
  }
  if (percentile >= 95) return '顶尖 5%'
  if (percentile >= 90) return '前 10%'
  if (percentile >= 75) return '前 25%'
  if (percentile >= 50) return '前 50%'
  return `前 ${100 - percentile}%`
}

// 分位配色
function getPercentileColor(percentile: number): string {
  if (percentile >= 90) return 'var(--color-accent-success)'
  if (percentile >= 70) return '#22c55e'
  if (percentile >= 50) return 'var(--color-accent-warning)'
  return 'var(--color-text-secondary)'
}

// 进度条组件
function ScoreBar({ 
  label, 
  score, 
  maxScore, 
  percentile,
  locked = false,
  language,
}: { 
  label: string
  score: number | null
  maxScore: number
  percentile?: number
  locked?: boolean
  language: string
}) {
  const color = getScoreColor(score, maxScore)
  const width = score != null ? (score / maxScore) * 100 : 0
  
  return (
    <Box style={{ marginBottom: tokens.spacing[3] }}>
      <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[1] }}>
        <Text size="sm" color="secondary">{label}</Text>
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
          {locked ? (
            <Box style={{ color: 'var(--color-text-quaternary)' }}>
              <LockIcon size={14} />
            </Box>
          ) : (
            <>
              <Text size="sm" weight="bold" style={{ color }}>
                {score != null ? score.toFixed(1) : '—'}
              </Text>
              <Text size="xs" color="tertiary">/ {maxScore}</Text>
            </>
          )}
        </Box>
      </Box>
      
      {/* 进度条 */}
      <Box
        style={{
          height: 6,
          background: 'var(--color-bg-tertiary)',
          borderRadius: tokens.radius.full,
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        {locked ? (
          <Box
            style={{
              position: 'absolute',
              inset: 0,
              background: `repeating-linear-gradient(
                45deg,
                var(--color-bg-secondary),
                var(--color-bg-secondary) 4px,
                var(--color-bg-tertiary) 4px,
                var(--color-bg-tertiary) 8px
              )`,
            }}
          />
        ) : (
          <Box
            style={{
              height: '100%',
              width: `${width}%`,
              background: `linear-gradient(90deg, ${color}cc 0%, ${color} 100%)`,
              borderRadius: tokens.radius.full,
              transition: 'width 0.5s ease',
            }}
          />
        )}
      </Box>
      
      {/* 分位信息 */}
      {!locked && percentile != null && (
        <Text 
          size="xs" 
          style={{ 
            color: getPercentileColor(percentile), 
            marginTop: 4,
            textAlign: 'right',
          }}
        >
          {language === 'en' ? 'Rank: ' : '同类 '}{getPercentileLabel(percentile, language)}
        </Text>
      )}
    </Box>
  )
}

export default function ScoreBreakdown({
  arenaScore,
  returnScore,
  drawdownScore,
  stabilityScore,
  source,
  percentile,
  isPro,
  onUnlock,
}: ScoreBreakdownProps) {
  const { language, t } = useLanguage()

  // 来源类型描述
  const getSourceTypeLabel = () => {
    if (!source) return language === 'en' ? 'traders' : '交易员'
    if (source.includes('futures')) return language === 'en' ? 'futures traders' : '合约交易员'
    if (source.includes('spot')) return language === 'en' ? 'spot traders' : '现货交易员'
    if (source.includes('web3')) return language === 'en' ? 'on-chain traders' : '链上交易员'
    return language === 'en' ? 'traders' : '交易员'
  }

  const sourceTypeLabel = getSourceTypeLabel()

  return (
    <Box
      style={{
        background: `linear-gradient(135deg, var(--color-bg-secondary) 0%, var(--color-bg-tertiary) 100%)`,
        borderRadius: tokens.radius.xl,
        border: '1px solid var(--color-border-primary)',
        padding: tokens.spacing[5],
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* 标题区 */}
      <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: tokens.spacing[4] }}>
        <Box>
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], marginBottom: 4 }}>
            <Text size="md" weight="bold">{t('scoreBreakdown')}</Text>
            {/* v2.0: 子分数免费可见，百分位需要 Pro */}
            {!isPro && (
              <Box
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 3,
                  padding: '2px 6px',
                  borderRadius: tokens.radius.full,
                  background: 'var(--color-bg-tertiary)',
                  border: '1px solid var(--color-border-secondary)',
                  fontSize: 9,
                  fontWeight: 600,
                  color: 'var(--color-text-tertiary)',
                }}
              >
                {language === 'en' ? 'Percentile requires Pro' : '百分位需要 Pro'}
              </Box>
            )}
          </Box>
          {/* Pro 用户显示百分位排名 */}
          {isPro && percentile && (
            <Text size="xs" color="tertiary">
              {language === 'en'
                ? `Ranks ${getPercentileLabel(percentile.overall, language)} among ${sourceTypeLabel}`
                : `在同类${sourceTypeLabel}中排名 ${getPercentileLabel(percentile.overall, language)}`
              }
            </Text>
          )}
        </Box>

        {/* 总分 - 所有人可见 */}
        <Box style={{ textAlign: 'right' }}>
          <Text
            size="2xl"
            weight="black"
            style={{
              color: getScoreColor(arenaScore, 100),
              lineHeight: 1,
            }}
          >
            {arenaScore != null ? arenaScore.toFixed(1) : '—'}
          </Text>
          <Text size="xs" color="tertiary">/ 100</Text>
        </Box>
      </Box>

      {/* v2.0: 子分数所有人可见，百分位仅 Pro 可见 */}
      <Box>
        <ScoreBar
          label={t('returnScore')}
          score={returnScore}
          maxScore={85}
          percentile={isPro ? percentile?.return : undefined}  // 仅 Pro 显示百分位
          locked={false}  // v2.0: 子分数不再锁定
          language={language}
        />
        <ScoreBar
          label={t('drawdownScore')}
          score={drawdownScore}
          maxScore={8}
          percentile={isPro ? percentile?.drawdown : undefined}
          locked={false}
          language={language}
        />
        <ScoreBar
          label={t('stabilityScore')}
          score={stabilityScore}
          maxScore={7}
          percentile={isPro ? percentile?.stability : undefined}
          locked={false}
          language={language}
        />
      </Box>

      {/* Pro 升级提示（非 Pro 用户） */}
      {!isPro && (
        <Box
          style={{
            marginTop: tokens.spacing[4],
            padding: tokens.spacing[3],
            background: 'var(--color-pro-glow)',
            borderRadius: tokens.radius.md,
            border: '1px solid var(--color-pro-gradient-start)30',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: tokens.spacing[3],
          }}
        >
          <Box>
            <Text size="xs" weight="bold" style={{ color: 'var(--color-pro-gradient-start)', marginBottom: 2 }}>
              {language === 'en' ? 'Want percentile rankings?' : '想看同类百分位排名？'}
            </Text>
            <Text size="xs" color="tertiary">
              {language === 'en'
                ? 'Pro members can see where this trader ranks among peers'
                : 'Pro 会员可查看该交易员在同类中的排名'}
            </Text>
          </Box>
          {onUnlock && (
            <Link href="/pricing" style={{ textDecoration: 'none', flexShrink: 0 }}>
              <Button
                variant="primary"
                size="sm"
                style={{
                  background: 'var(--color-pro-badge-bg)',
                  border: 'none',
                  padding: '6px 12px',
                  fontSize: '12px',
                }}
              >
                {t('upgrade')}
              </Button>
            </Link>
          )}
        </Box>
      )}

      {/* 评分说明 - 所有人可见 */}
      <Box
        style={{
          marginTop: tokens.spacing[4],
          padding: tokens.spacing[3],
          background: 'var(--color-bg-tertiary)',
          borderRadius: tokens.radius.md,
          borderLeft: `3px solid ${isPro ? 'var(--color-pro-glow)' : 'var(--color-border-primary)'}`,
        }}
      >
        <Text size="xs" color="tertiary" style={{ lineHeight: 1.6 }}>
          <strong style={{ color: 'var(--color-text-secondary)' }}>
            {language === 'en' ? 'Score Guide' : '评分说明'}
          </strong><br />
          {language === 'en'
            ? <>Return Score (0-85): Based on ROI performance<br />
               Drawdown Score (0-8): Lower drawdown = higher score<br />
               Stability Score (0-7): Based on win rate</>
            : <>收益分 (0-85)：基于 ROI 强度计算<br />
               回撤分 (0-8)：回撤越小分数越高<br />
               稳定分 (0-7)：基于胜率计算</>
          }
        </Text>
      </Box>
    </Box>
  )
}
