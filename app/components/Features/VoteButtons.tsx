'use client'

import { useState } from 'react'
import { ThumbsUpIcon, ThumbsDownIcon } from '../Icons'
import { tokens } from '@/lib/design-tokens'

export interface VoteData {
  upvotes: number
  downvotes: number
  userVote: 'up' | 'down' | null
}

export interface VoteButtonsProps {
  /** 初始投票数据 */
  initialData?: VoteData
  /** 投票变化回调 */
  onVoteChange?: (vote: 'up' | 'down' | null, data: VoteData) => void
  /** 是否显示数量 */
  showCount?: boolean
  /** 是否禁用 */
  disabled?: boolean
  /** 自定义样式 */
  style?: React.CSSProperties
}

/**
 * 投票按钮组件 - 赞同/反对
 * 支持 mock 数据和实时投票
 */
export default function VoteButtons({
  initialData,
  onVoteChange,
  showCount = true,
  disabled = false,
  style,
}: VoteButtonsProps) {
  const [voteData, setVoteData] = useState<VoteData>(
    initialData || {
      upvotes: 0,
      downvotes: 0,
      userVote: null,
    }
  )

  const handleVote = (direction: 'up' | 'down') => {
    if (disabled) return

    const newData: VoteData = { ...voteData }
    const currentVote = voteData.userVote

    if (currentVote === direction) {
      // 取消投票
      newData.userVote = null
      newData[direction === 'up' ? 'upvotes' : 'downvotes'] = Math.max(
        0,
        newData[direction === 'up' ? 'upvotes' : 'downvotes'] - 1
      )
    } else {
      // 切换投票
      if (currentVote) {
        // 先取消之前的投票
        newData[currentVote === 'up' ? 'upvotes' : 'downvotes'] = Math.max(
          0,
          newData[currentVote === 'up' ? 'upvotes' : 'downvotes'] - 1
        )
      }
      // 添加新投票
      newData.userVote = direction
      newData[direction === 'up' ? 'upvotes' : 'downvotes'] =
        newData[direction === 'up' ? 'upvotes' : 'downvotes'] + 1
    }

    setVoteData(newData)
    onVoteChange?.(newData.userVote, newData)
  }

  const isUpActive = voteData.userVote === 'up'
  const isDownActive = voteData.userVote === 'down'

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacing[2],
        ...style,
      }}
    >
      {/* 赞同按钮 */}
      <button
        onClick={() => handleVote('up')}
        disabled={disabled}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spacing[1],
          padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
          borderRadius: tokens.radius.md,
          border: 'none',
          background: isUpActive
            ? 'rgba(139, 111, 168, 0.15)'
            : 'transparent',
          color: isUpActive ? tokens.colors.accent.primary : tokens.colors.text.secondary,
          cursor: disabled ? 'not-allowed' : 'pointer',
          fontSize: tokens.typography.fontSize.sm,
          fontWeight: isUpActive ? 900 : 700,
          transition: 'all 0.2s ease',
          opacity: disabled ? 0.5 : 1,
        }}
        onMouseEnter={(e) => {
          if (!disabled && !isUpActive) {
            e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'
            e.currentTarget.style.color = tokens.colors.text.primary
          }
        }}
        onMouseLeave={(e) => {
          if (!disabled && !isUpActive) {
            e.currentTarget.style.background = 'transparent'
            e.currentTarget.style.color = tokens.colors.text.secondary
          }
        }}
      >
        <ThumbsUpIcon
          size={16}
          style={{
            transition: 'transform 0.2s ease',
            transform: isUpActive ? 'scale(1.15)' : 'scale(1)',
          }}
        />
        {showCount && (
          <span style={{ minWidth: '20px', textAlign: 'left' }}>
            {voteData.upvotes}
          </span>
        )}
      </button>

      {/* 反对按钮 */}
      <button
        onClick={() => handleVote('down')}
        disabled={disabled}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spacing[1],
          padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
          borderRadius: tokens.radius.md,
          border: 'none',
          background: isDownActive
            ? 'rgba(220, 38, 38, 0.15)'
            : 'transparent',
          color: isDownActive
            ? tokens.colors.accent.error
            : tokens.colors.text.secondary,
          cursor: disabled ? 'not-allowed' : 'pointer',
          fontSize: tokens.typography.fontSize.sm,
          fontWeight: isDownActive ? 900 : 700,
          transition: 'all 0.2s ease',
          opacity: disabled ? 0.5 : 1,
        }}
        onMouseEnter={(e) => {
          if (!disabled && !isDownActive) {
            e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'
            e.currentTarget.style.color = tokens.colors.text.primary
          }
        }}
        onMouseLeave={(e) => {
          if (!disabled && !isDownActive) {
            e.currentTarget.style.background = 'transparent'
            e.currentTarget.style.color = tokens.colors.text.secondary
          }
        }}
      >
        <ThumbsDownIcon
          size={16}
          style={{
            transition: 'transform 0.2s ease',
            transform: isDownActive ? 'scale(1.15)' : 'scale(1)',
          }}
        />
        {showCount && (
          <span style={{ minWidth: '20px', textAlign: 'left' }}>
            {voteData.downvotes}
          </span>
        )}
      </button>
    </div>
  )
}

/**
 * Mock 投票数据生成器
 */
export function generateMockVoteData(seed?: number): VoteData {
  let random: () => number
  if (seed !== undefined) {
    let value = seed
    random = () => {
      value = (value * 9301 + 49297) % 233280
      return value / 233280
    }
  } else {
    random = Math.random
  }

  const upvotes = Math.floor(random() * 1000) + 10
  const downvotes = Math.floor(random() * upvotes * 0.2)
  const userVote: 'up' | 'down' | null = random() > 0.7 ? (random() > 0.5 ? 'up' : 'down') : null

  return {
    upvotes,
    downvotes,
    userVote,
  }
}

/**
 * Mock 投票数据列表（用于测试）
 */
export const mockVoteDataList: VoteData[] = [
  { upvotes: 1234, downvotes: 56, userVote: 'up' },
  { upvotes: 892, downvotes: 123, userVote: null },
  { upvotes: 567, downvotes: 89, userVote: 'down' },
  { upvotes: 2345, downvotes: 12, userVote: 'up' },
  { upvotes: 456, downvotes: 234, userVote: null },
  { upvotes: 789, downvotes: 45, userVote: 'up' },
  { upvotes: 345, downvotes: 67, userVote: null },
  { upvotes: 1234, downvotes: 234, userVote: 'down' },
]

