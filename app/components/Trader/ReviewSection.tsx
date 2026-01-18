'use client'

import { useState, useEffect, useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '../Base'
import { supabase } from '@/lib/supabase/client'
import { useLanguage } from '../Utils/LanguageProvider'
import { useToast } from '../UI/Toast'
import { getCsrfHeaders } from '@/lib/api/client'
import { formatTimeAgo } from '@/lib/utils/date'
import { getAvatarGradient, getAvatarInitial } from '@/lib/utils/avatar'

// ============================================
// 类型定义
// ============================================

interface TraderReview {
  id: string
  trader_id: string
  source: string
  user_id: string
  overall_rating: number
  stability_rating: number | null
  drawdown_rating: number | null
  review_text: string | null
  follow_duration_days: number | null
  profit_loss_percent: number | null
  would_recommend: boolean | null
  screenshot_url: string | null
  verified: boolean
  helpful_count: number
  unhelpful_count: number
  created_at: string
  author_handle?: string
  author_avatar_url?: string
  user_vote?: 'helpful' | 'unhelpful' | null
}

interface CommunityScore {
  trader_id: string
  source: string
  avg_rating: number
  avg_stability: number | null
  avg_drawdown: number | null
  review_count: number
  recommend_rate: number
  avg_follow_days: number | null
  avg_profit_loss: number | null
  verified_reviews: number
}

interface ReviewSectionProps {
  traderId: string
  source: string
  traderData?: {
    roi?: number
    max_drawdown?: number
    win_rate?: number
    followers?: number
  }
}

// ============================================
// 快评模板定义
// ============================================

const QUICK_REVIEW_PRESETS = [
  { 
    id: 'excellent',
    label: '🌟 强烈推荐', 
    rating: 5, 
    recommend: true,
    color: tokens.colors.accent.success,
    description: '收益稳定，回撤可控，值得长期跟单'
  },
  { 
    id: 'good',
    label: '👍 还不错', 
    rating: 4, 
    recommend: true,
    color: '#4CAF50',
    description: '整体表现不错，有一定盈利'
  },
  { 
    id: 'average',
    label: '😐 一般', 
    rating: 3, 
    recommend: null,
    color: tokens.colors.text.secondary,
    description: '表现平平，需要观望'
  },
  { 
    id: 'poor',
    label: '👎 不推荐', 
    rating: 2, 
    recommend: false,
    color: tokens.colors.accent.warning,
    description: '风险较大，建议谨慎'
  },
  { 
    id: 'avoid',
    label: '⚠️ 避雷', 
    rating: 1, 
    recommend: false,
    color: tokens.colors.accent.error,
    description: '风险极高，强烈不推荐'
  },
]

// ============================================
// 星级显示组件
// ============================================

function StarRating({ 
  rating, 
  size = 16, 
  interactive = false, 
  onChange 
}: { 
  rating: number
  size?: number
  interactive?: boolean
  onChange?: (rating: number) => void
}) {
  const [hoverRating, setHoverRating] = useState(0)
  
  return (
    <Box style={{ display: 'flex', gap: 2 }}>
      {[1, 2, 3, 4, 5].map((star) => {
        const filled = interactive ? (hoverRating || rating) >= star : rating >= star
        const halfFilled = !interactive && !filled && rating >= star - 0.5
        
        return (
          <Box
            key={star}
            style={{
              cursor: interactive ? 'pointer' : 'default',
              transition: 'transform 0.2s ease',
              transform: interactive && hoverRating === star ? 'scale(1.2)' : 'scale(1)',
            }}
            onClick={() => interactive && onChange?.(star)}
            onMouseEnter={() => interactive && setHoverRating(star)}
            onMouseLeave={() => interactive && setHoverRating(0)}
          >
            <svg 
              width={size} 
              height={size} 
              viewBox="0 0 24 24" 
              fill={filled ? '#FFD700' : halfFilled ? 'url(#half)' : 'none'} 
              stroke={filled || halfFilled ? '#FFD700' : tokens.colors.text.tertiary}
              strokeWidth="2"
            >
              {halfFilled && (
                <defs>
                  <linearGradient id="half">
                    <stop offset="50%" stopColor="#FFD700" />
                    <stop offset="50%" stopColor="transparent" />
                  </linearGradient>
                </defs>
              )}
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
          </Box>
        )
      })}
    </Box>
  )
}

// ============================================
// 简化版评价表单组件
// ============================================

function QuickReviewForm({ 
  traderId, 
  source, 
  onSuccess,
  onCancel,
  existingReview,
}: { 
  traderId: string
  source: string
  onSuccess: () => void
  onCancel: () => void
  existingReview?: TraderReview | null
}) {
  const { showToast } = useToast()
  const [loading, setLoading] = useState(false)
  const [mode, setMode] = useState<'quick' | 'detailed'>('quick')
  const [selectedPreset, setSelectedPreset] = useState<string | null>(
    existingReview ? QUICK_REVIEW_PRESETS.find(p => p.rating === existingReview.overall_rating)?.id || null : null
  )
  
  // 详细模式字段
  const [overallRating, setOverallRating] = useState(existingReview?.overall_rating || 0)
  const [stabilityRating, setStabilityRating] = useState(existingReview?.stability_rating || 0)
  const [drawdownRating, setDrawdownRating] = useState(existingReview?.drawdown_rating || 0)
  const [reviewText, setReviewText] = useState(existingReview?.review_text || '')
  const [followDuration, setFollowDuration] = useState(existingReview?.follow_duration_days?.toString() || '')
  const [profitLoss, setProfitLoss] = useState(existingReview?.profit_loss_percent?.toString() || '')
  const [wouldRecommend, setWouldRecommend] = useState<boolean | null>(existingReview?.would_recommend ?? null)

  const handlePresetSelect = (presetId: string) => {
    setSelectedPreset(presetId)
    const preset = QUICK_REVIEW_PRESETS.find(p => p.id === presetId)
    if (preset) {
      setOverallRating(preset.rating)
      setWouldRecommend(preset.recommend)
    }
  }

  const handleSubmit = async () => {
    if (mode === 'quick' && !selectedPreset) {
      showToast('请选择评价', 'error')
      return
    }
    if (mode === 'detailed' && overallRating === 0) {
      showToast('请选择总体评分', 'error')
      return
    }

    setLoading(true)
    try {
      const preset = selectedPreset ? QUICK_REVIEW_PRESETS.find(p => p.id === selectedPreset) : null
      
      const endpoint = existingReview 
        ? `/api/reviews/${existingReview.id}` 
        : '/api/reviews'
      const method = existingReview ? 'PUT' : 'POST'

      const body = mode === 'quick' && preset
        ? {
            trader_id: traderId,
            source,
            overall_rating: preset.rating,
            would_recommend: preset.recommend,
            review_text: reviewText || undefined,
          }
        : {
            trader_id: traderId,
            source,
            overall_rating: overallRating,
            stability_rating: stabilityRating || undefined,
            drawdown_rating: drawdownRating || undefined,
            review_text: reviewText || undefined,
            follow_duration_days: followDuration ? parseInt(followDuration) : undefined,
            profit_loss_percent: profitLoss ? parseFloat(profitLoss) : undefined,
            would_recommend: wouldRecommend,
          }

      const res = await fetch(endpoint, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...getCsrfHeaders(),
        },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.message || '提交失败')
      }

      showToast(existingReview ? '评价已更新' : '评价提交成功！感谢你的分享', 'success')
      onSuccess()
    } catch (error) {
      showToast(error instanceof Error ? error.message : '提交失败', 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Box
      style={{
        padding: tokens.spacing[5],
        background: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.xl,
        border: `1px solid ${tokens.colors.border.primary}`,
        marginBottom: tokens.spacing[4],
      }}
    >
      {/* 标题和模式切换 */}
      <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[4] }}>
        <Text size="lg" weight="bold">
          {existingReview ? '编辑评价' : '快速评价'}
        </Text>
        <Box style={{ display: 'flex', gap: tokens.spacing[1] }}>
          <Button
            variant={mode === 'quick' ? 'primary' : 'ghost'}
            size="sm"
            onClick={() => setMode('quick')}
            style={{ 
              padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
              fontSize: tokens.typography.fontSize.xs,
            }}
          >
            快评
          </Button>
          <Button
            variant={mode === 'detailed' ? 'primary' : 'ghost'}
            size="sm"
            onClick={() => setMode('detailed')}
            style={{ 
              padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
              fontSize: tokens.typography.fontSize.xs,
            }}
          >
            详细
          </Button>
        </Box>
      </Box>

      {mode === 'quick' ? (
        /* 快评模式：预设模板 */
        <>
          <Box 
            style={{ 
              display: 'grid', 
              gridTemplateColumns: 'repeat(auto-fit, minmax(100px, 1fr))',
              gap: tokens.spacing[2],
              marginBottom: tokens.spacing[4],
            }}
          >
            {QUICK_REVIEW_PRESETS.map((preset) => (
              <Box
                key={preset.id}
                onClick={() => handlePresetSelect(preset.id)}
                style={{
                  padding: tokens.spacing[3],
                  background: selectedPreset === preset.id 
                    ? `${preset.color}20`
                    : tokens.colors.bg.tertiary,
                  border: `2px solid ${selectedPreset === preset.id ? preset.color : 'transparent'}`,
                  borderRadius: tokens.radius.lg,
                  cursor: 'pointer',
                  textAlign: 'center',
                  transition: 'all 0.2s ease',
                }}
              >
                <Text size="sm" weight="semibold" style={{ color: preset.color }}>
                  {preset.label}
                </Text>
                <Box style={{ marginTop: tokens.spacing[1] }}>
                  <StarRating rating={preset.rating} size={12} />
                </Box>
              </Box>
            ))}
          </Box>

          {/* 可选：补充说明 */}
          <Box style={{ marginBottom: tokens.spacing[4] }}>
            <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[2] }}>
              补充说明（可选）
            </Text>
            <textarea
              placeholder="分享更多跟单体验..."
              value={reviewText}
              onChange={(e) => setReviewText(e.target.value)}
              maxLength={500}
              style={{
                width: '100%',
                minHeight: 60,
                padding: tokens.spacing[3],
                background: tokens.colors.bg.primary,
                border: `1px solid ${tokens.colors.border.primary}`,
                borderRadius: tokens.radius.md,
                color: tokens.colors.text.primary,
                fontSize: tokens.typography.fontSize.sm,
                resize: 'vertical',
              }}
            />
          </Box>
        </>
      ) : (
        /* 详细模式：完整表单 */
        <>
          {/* 总体评分 */}
          <Box style={{ marginBottom: tokens.spacing[4] }}>
            <Text size="sm" weight="semibold" style={{ marginBottom: tokens.spacing[2] }}>
              总体评分 *
            </Text>
            <StarRating rating={overallRating} size={28} interactive onChange={setOverallRating} />
          </Box>

          {/* 分项评分（默认折叠） */}
          <details style={{ marginBottom: tokens.spacing[4] }}>
            <summary 
              style={{ 
                cursor: 'pointer', 
                color: tokens.colors.text.secondary,
                fontSize: tokens.typography.fontSize.sm,
                marginBottom: tokens.spacing[2],
              }}
            >
              分项评分（可选）
            </summary>
            <Box style={{ display: 'flex', gap: tokens.spacing[6], marginTop: tokens.spacing[2], flexWrap: 'wrap' }}>
              <Box>
                <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
                  稳定性
                </Text>
                <StarRating rating={stabilityRating} size={18} interactive onChange={setStabilityRating} />
              </Box>
              <Box>
                <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
                  回撤控制
                </Text>
                <StarRating rating={drawdownRating} size={18} interactive onChange={setDrawdownRating} />
              </Box>
            </Box>
          </details>

          {/* 跟单信息（默认折叠） */}
          <details style={{ marginBottom: tokens.spacing[4] }}>
            <summary 
              style={{ 
                cursor: 'pointer', 
                color: tokens.colors.text.secondary,
                fontSize: tokens.typography.fontSize.sm,
                marginBottom: tokens.spacing[2],
              }}
            >
              跟单数据（可选）
            </summary>
            <Box style={{ display: 'flex', gap: tokens.spacing[4], marginTop: tokens.spacing[2], flexWrap: 'wrap' }}>
              <Box style={{ flex: 1, minWidth: 100 }}>
                <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
                  跟单天数
                </Text>
                <input
                  type="number"
                  placeholder="30"
                  value={followDuration}
                  onChange={(e) => setFollowDuration(e.target.value)}
                  style={{
                    width: '100%',
                    padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                    background: tokens.colors.bg.primary,
                    border: `1px solid ${tokens.colors.border.primary}`,
                    borderRadius: tokens.radius.md,
                    color: tokens.colors.text.primary,
                    fontSize: tokens.typography.fontSize.sm,
                  }}
                />
              </Box>
              <Box style={{ flex: 1, minWidth: 100 }}>
                <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
                  盈亏 (%)
                </Text>
                <input
                  type="number"
                  placeholder="15.5"
                  value={profitLoss}
                  onChange={(e) => setProfitLoss(e.target.value)}
                  style={{
                    width: '100%',
                    padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                    background: tokens.colors.bg.primary,
                    border: `1px solid ${tokens.colors.border.primary}`,
                    borderRadius: tokens.radius.md,
                    color: tokens.colors.text.primary,
                    fontSize: tokens.typography.fontSize.sm,
                  }}
                />
              </Box>
            </Box>
          </details>

          {/* 是否推荐 */}
          <Box style={{ marginBottom: tokens.spacing[4] }}>
            <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[2] }}>
              是否推荐?
            </Text>
            <Box style={{ display: 'flex', gap: tokens.spacing[2] }}>
              {[
                { value: true, label: '👍 推荐' },
                { value: false, label: '👎 不推荐' },
              ].map(({ value, label }) => (
                <Button
                  key={label}
                  variant={wouldRecommend === value ? 'primary' : 'secondary'}
                  size="sm"
                  onClick={() => setWouldRecommend(value)}
                  style={{
                    background: wouldRecommend === value 
                      ? (value ? tokens.colors.accent.success : tokens.colors.accent.error)
                      : tokens.colors.bg.tertiary,
                  }}
                >
                  {label}
                </Button>
              ))}
            </Box>
          </Box>

          {/* 评价内容 */}
          <Box style={{ marginBottom: tokens.spacing[4] }}>
            <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[2] }}>
              详细评价
            </Text>
            <textarea
              placeholder="分享你的跟单体验..."
              value={reviewText}
              onChange={(e) => setReviewText(e.target.value)}
              maxLength={2000}
              style={{
                width: '100%',
                minHeight: 80,
                padding: tokens.spacing[3],
                background: tokens.colors.bg.primary,
                border: `1px solid ${tokens.colors.border.primary}`,
                borderRadius: tokens.radius.md,
                color: tokens.colors.text.primary,
                fontSize: tokens.typography.fontSize.sm,
                resize: 'vertical',
              }}
            />
          </Box>
        </>
      )}

      {/* 按钮区 */}
      <Box style={{ display: 'flex', gap: tokens.spacing[2] }}>
        <Button
          variant="ghost"
          onClick={onCancel}
          style={{ flex: 1 }}
        >
          取消
        </Button>
        <Button
          variant="primary"
          onClick={handleSubmit}
          disabled={loading || (mode === 'quick' ? !selectedPreset : overallRating === 0)}
          style={{ flex: 2 }}
        >
          {loading ? '提交中...' : '提交评价'}
        </Button>
      </Box>
    </Box>
  )
}

// ============================================
// 官方数据摘要组件（空状态时展示）
// ============================================

function TraderOfficialStats({ traderData }: { traderData?: ReviewSectionProps['traderData'] }) {
  if (!traderData) return null
  
  const stats = [
    { label: '收益率', value: traderData.roi, format: (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`, color: (v: number) => v >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error },
    { label: '最大回撤', value: traderData.max_drawdown, format: (v: number) => `${v.toFixed(1)}%`, color: () => tokens.colors.accent.warning },
    { label: '胜率', value: traderData.win_rate, format: (v: number) => `${v.toFixed(1)}%`, color: (v: number) => v >= 50 ? tokens.colors.accent.success : tokens.colors.text.secondary },
    { label: '跟单人数', value: traderData.followers, format: (v: number) => v.toLocaleString(), color: () => tokens.colors.text.primary },
  ].filter(s => s.value !== undefined && s.value !== null)
  
  if (stats.length === 0) return null
  
  return (
    <Box
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(80px, 1fr))',
        gap: tokens.spacing[3],
        padding: tokens.spacing[4],
        background: tokens.colors.bg.tertiary,
        borderRadius: tokens.radius.lg,
        marginBottom: tokens.spacing[4],
      }}
    >
      {stats.map((stat) => (
        <Box key={stat.label} style={{ textAlign: 'center' }}>
          <Text size="lg" weight="bold" style={{ color: stat.color(stat.value!) }}>
            {stat.format(stat.value!)}
          </Text>
          <Text size="xs" color="tertiary">{stat.label}</Text>
        </Box>
      ))}
    </Box>
  )
}

// ============================================
// 单个评价卡片
// ============================================

function ReviewCard({ 
  review, 
  currentUserId,
  onVote,
}: { 
  review: TraderReview
  currentUserId: string | null
  onVote: (reviewId: string, voteType: 'helpful' | 'unhelpful' | null) => void
}) {
  const handleVote = async (voteType: 'helpful' | 'unhelpful') => {
    if (!currentUserId) return
    
    if (review.user_vote === voteType) {
      onVote(review.id, null)
    } else {
      onVote(review.id, voteType)
    }
  }

  return (
    <Box
      style={{
        padding: tokens.spacing[4],
        background: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.lg,
        border: `1px solid ${tokens.colors.border.primary}`,
        marginBottom: tokens.spacing[3],
      }}
    >
      {/* 头部 */}
      <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: tokens.spacing[3] }}>
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
          <Box
            style={{
              width: 40,
              height: 40,
              borderRadius: tokens.radius.full,
              background: review.author_avatar_url ? tokens.colors.bg.tertiary : getAvatarGradient(review.user_id),
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
              flexShrink: 0,
            }}
          >
            {review.author_avatar_url ? (
              <img
                src={review.author_avatar_url}
                alt={review.author_handle}
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
            ) : (
              <Text size="sm" weight="bold" style={{ color: '#fff' }}>
                {getAvatarInitial(review.author_handle || '用户')}
              </Text>
            )}
          </Box>
          
          <Box>
            <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
              <Text size="sm" weight="semibold">
                {review.author_handle || '匿名用户'}
              </Text>
              {review.verified && (
                <Box
                  style={{
                    padding: `2px ${tokens.spacing[2]}`,
                    background: `${tokens.colors.accent.success}20`,
                    borderRadius: tokens.radius.full,
                  }}
                >
                  <Text size="xs" style={{ color: tokens.colors.accent.success }}>
                    已验证
                  </Text>
                </Box>
              )}
            </Box>
            <Text size="xs" color="tertiary">
              {formatTimeAgo(review.created_at)}
              {review.follow_duration_days && ` · 跟单 ${review.follow_duration_days} 天`}
            </Text>
          </Box>
        </Box>

        <Box style={{ textAlign: 'right' }}>
          <StarRating rating={review.overall_rating} size={16} />
          {review.profit_loss_percent !== null && (
            <Text 
              size="sm" 
              weight="bold"
              style={{ 
                color: review.profit_loss_percent >= 0 
                  ? tokens.colors.accent.success 
                  : tokens.colors.accent.error,
                marginTop: tokens.spacing[1],
              }}
            >
              {review.profit_loss_percent >= 0 ? '+' : ''}{review.profit_loss_percent.toFixed(1)}%
            </Text>
          )}
        </Box>
      </Box>

      {/* 推荐状态 */}
      {review.would_recommend !== null && (
        <Box 
          style={{ 
            display: 'inline-flex',
            alignItems: 'center',
            gap: tokens.spacing[1],
            padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
            background: review.would_recommend 
              ? `${tokens.colors.accent.success}15`
              : `${tokens.colors.accent.error}15`,
            borderRadius: tokens.radius.md,
            marginBottom: tokens.spacing[3],
          }}
        >
          <Text size="sm">
            {review.would_recommend ? '👍' : '👎'}
          </Text>
          <Text 
            size="xs" 
            weight="semibold"
            style={{ 
              color: review.would_recommend 
                ? tokens.colors.accent.success 
                : tokens.colors.accent.error 
            }}
          >
            {review.would_recommend ? '推荐' : '不推荐'}
          </Text>
        </Box>
      )}

      {/* 评价内容 */}
      {review.review_text && (
        <Text size="sm" style={{ marginBottom: tokens.spacing[3], lineHeight: 1.6 }}>
          {review.review_text}
        </Text>
      )}

      {/* 分项评分 */}
      {(review.stability_rating || review.drawdown_rating) && (
        <Box 
          style={{ 
            display: 'flex', 
            gap: tokens.spacing[4], 
            marginBottom: tokens.spacing[3],
            flexWrap: 'wrap',
          }}
        >
          {review.stability_rating && (
            <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
              <Text size="xs" color="tertiary">稳定性:</Text>
              <StarRating rating={review.stability_rating} size={12} />
            </Box>
          )}
          {review.drawdown_rating && (
            <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
              <Text size="xs" color="tertiary">回撤控制:</Text>
              <StarRating rating={review.drawdown_rating} size={12} />
            </Box>
          )}
        </Box>
      )}

      {/* 投票 */}
      <Box 
        style={{ 
          display: 'flex', 
          alignItems: 'center', 
          gap: tokens.spacing[3],
          paddingTop: tokens.spacing[3],
          borderTop: `1px solid ${tokens.colors.border.primary}`,
        }}
      >
        <Text size="xs" color="tertiary">这条评价有帮助吗?</Text>
        <Box style={{ display: 'flex', gap: tokens.spacing[2] }}>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => handleVote('helpful')}
            disabled={!currentUserId}
            style={{
              padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
              background: review.user_vote === 'helpful' 
                ? `${tokens.colors.accent.success}20`
                : 'transparent',
              color: review.user_vote === 'helpful'
                ? tokens.colors.accent.success
                : tokens.colors.text.secondary,
            }}
          >
            👍 {review.helpful_count}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => handleVote('unhelpful')}
            disabled={!currentUserId}
            style={{
              padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
              background: review.user_vote === 'unhelpful' 
                ? `${tokens.colors.accent.error}20`
                : 'transparent',
              color: review.user_vote === 'unhelpful'
                ? tokens.colors.accent.error
                : tokens.colors.text.secondary,
            }}
          >
            👎 {review.unhelpful_count}
          </Button>
        </Box>
      </Box>
    </Box>
  )
}

// ============================================
// 主组件
// ============================================

export default function ReviewSection({ traderId, source, traderData }: ReviewSectionProps) {
  const { showToast } = useToast()
  const [loading, setLoading] = useState(true)
  const [reviews, setReviews] = useState<TraderReview[]>([])
  const [communityScore, setCommunityScore] = useState<CommunityScore | null>(null)
  const [userReview, setUserReview] = useState<TraderReview | null>(null)
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [sortBy, setSortBy] = useState<'created_at' | 'helpful_count'>('created_at')

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setCurrentUserId(data.user?.id ?? null)
    })
  }, [])

  const loadReviews = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(
        `/api/reviews?trader_id=${encodeURIComponent(traderId)}&source=${encodeURIComponent(source)}&sort_by=${sortBy}&limit=50`
      )
      const data = await res.json()
      
      if (res.ok) {
        setReviews(data.data?.reviews || [])
        setCommunityScore(data.data?.community_score || null)
        setUserReview(data.data?.user_review || null)
      }
    } catch (error) {
      console.error('加载评价失败:', error)
    } finally {
      setLoading(false)
    }
  }, [traderId, source, sortBy])

  useEffect(() => {
    loadReviews()
  }, [loadReviews])

  const handleVote = async (reviewId: string, voteType: 'helpful' | 'unhelpful' | null) => {
    if (!currentUserId) {
      showToast('请先登录', 'error')
      return
    }

    try {
      if (voteType === null) {
        await fetch(`/api/reviews/${reviewId}/vote`, {
          method: 'DELETE',
          headers: getCsrfHeaders(),
        })
      } else {
        await fetch(`/api/reviews/${reviewId}/vote`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...getCsrfHeaders(),
          },
          body: JSON.stringify({ vote_type: voteType }),
        })
      }
      loadReviews()
    } catch (error) {
      showToast('操作失败', 'error')
    }
  }

  return (
    <Box style={{ marginTop: tokens.spacing[6] }}>
      {/* 标题栏 */}
      <Box 
        style={{ 
          display: 'flex', 
          justifyContent: 'space-between', 
          alignItems: 'center',
          marginBottom: tokens.spacing[4],
        }}
      >
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
          <Text size="xl" weight="bold">
            用户评价
          </Text>
          {communityScore && (
            <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
              <StarRating rating={communityScore.avg_rating} size={18} />
              <Text size="sm" weight="semibold">
                {communityScore.avg_rating.toFixed(1)}
              </Text>
              <Text size="sm" color="tertiary">
                ({communityScore.review_count} 条评价)
              </Text>
            </Box>
          )}
        </Box>

        <Box style={{ display: 'flex', gap: tokens.spacing[2] }}>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as 'created_at' | 'helpful_count')}
            style={{
              padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
              background: tokens.colors.bg.secondary,
              border: `1px solid ${tokens.colors.border.primary}`,
              borderRadius: tokens.radius.md,
              color: tokens.colors.text.primary,
              fontSize: tokens.typography.fontSize.sm,
            }}
          >
            <option value="created_at">最新</option>
            <option value="helpful_count">最有帮助</option>
          </select>

          {currentUserId && !userReview && !showForm && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => setShowForm(true)}
            >
              ✨ 快速评价
            </Button>
          )}
        </Box>
      </Box>

      {/* 社区评分概览 */}
      {communityScore && communityScore.review_count > 0 && (
        <Box
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(100px, 1fr))',
            gap: tokens.spacing[3],
            padding: tokens.spacing[4],
            background: tokens.colors.bg.secondary,
            borderRadius: tokens.radius.lg,
            border: `1px solid ${tokens.colors.border.primary}`,
            marginBottom: tokens.spacing[4],
          }}
        >
          <Box style={{ textAlign: 'center' }}>
            <Text size="2xl" weight="bold" style={{ color: '#FFD700' }}>
              {communityScore.avg_rating.toFixed(1)}
            </Text>
            <Text size="xs" color="tertiary">综合评分</Text>
          </Box>
          <Box style={{ textAlign: 'center' }}>
            <Text 
              size="2xl" 
              weight="bold"
              style={{ 
                color: communityScore.recommend_rate >= 0.5 
                  ? tokens.colors.accent.success 
                  : tokens.colors.accent.error 
              }}
            >
              {(communityScore.recommend_rate * 100).toFixed(0)}%
            </Text>
            <Text size="xs" color="tertiary">推荐率</Text>
          </Box>
          {communityScore.avg_profit_loss !== null && (
            <Box style={{ textAlign: 'center' }}>
              <Text 
                size="2xl" 
                weight="bold"
                style={{ 
                  color: communityScore.avg_profit_loss >= 0 
                    ? tokens.colors.accent.success 
                    : tokens.colors.accent.error 
                }}
              >
                {communityScore.avg_profit_loss >= 0 ? '+' : ''}{communityScore.avg_profit_loss.toFixed(1)}%
              </Text>
              <Text size="xs" color="tertiary">平均盈亏</Text>
            </Box>
          )}
          {communityScore.avg_follow_days !== null && (
            <Box style={{ textAlign: 'center' }}>
              <Text size="2xl" weight="bold">
                {Math.round(communityScore.avg_follow_days)}
              </Text>
              <Text size="xs" color="tertiary">平均跟单天数</Text>
            </Box>
          )}
        </Box>
      )}

      {/* 评价表单 */}
      {showForm && (
        <QuickReviewForm
          traderId={traderId}
          source={source}
          existingReview={userReview}
          onSuccess={() => {
            setShowForm(false)
            loadReviews()
          }}
          onCancel={() => setShowForm(false)}
        />
      )}

      {/* 用户自己的评价 */}
      {userReview && !showForm && (
        <Box style={{ marginBottom: tokens.spacing[4] }}>
          <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[2] }}>
            <Text size="sm" weight="semibold" color="secondary">
              我的评价
            </Text>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowForm(true)}
              style={{ color: tokens.colors.accent.primary }}
            >
              编辑
            </Button>
          </Box>
          <ReviewCard 
            review={{ ...userReview, author_handle: '我' }}
            currentUserId={currentUserId}
            onVote={handleVote}
          />
        </Box>
      )}

      {/* 评价列表或空状态 */}
      {loading ? (
        <Box style={{ textAlign: 'center', padding: tokens.spacing[6] }}>
          <Text color="tertiary">加载中...</Text>
        </Box>
      ) : reviews.length === 0 ? (
        /* 优化的空状态 */
        <Box 
          style={{ 
            padding: tokens.spacing[6],
            background: tokens.colors.bg.secondary,
            borderRadius: tokens.radius.lg,
            border: `1px solid ${tokens.colors.border.primary}`,
          }}
        >
          {/* 显示官方数据摘要 */}
          <TraderOfficialStats traderData={traderData} />
          
          <Box style={{ textAlign: 'center' }}>
            <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[3] }}>
              该交易员尚无用户评价，以上为交易所公开数据
            </Text>
            
            {currentUserId && !showForm ? (
              <Button
                variant="primary"
                size="sm"
                onClick={() => setShowForm(true)}
              >
                ✨ 成为第一个评价者
              </Button>
            ) : !currentUserId && (
              <Text size="xs" color="tertiary">
                跟单过该交易员？登录后分享你的体验
              </Text>
            )}
          </Box>
        </Box>
      ) : (
        <Box>
          {reviews
            .filter(r => r.id !== userReview?.id)
            .map((review) => (
              <ReviewCard
                key={review.id}
                review={review}
                currentUserId={currentUserId}
                onVote={handleVote}
              />
            ))}
        </Box>
      )}
    </Box>
  )
}
