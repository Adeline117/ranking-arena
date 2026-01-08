'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../Base'
import { CloseIcon } from '../Icons'

interface SearchDropdownProps {
  open: boolean
  query: string
  onClose: () => void
}

interface SearchHistoryItem {
  id: string
  query: string
  timestamp: number
}

interface HotPost {
  id: number
  title: string
  hotScore: number
  rank: number
}

/**
 * 搜索下拉菜单
 * - 显示搜索历史记录（可删除）
 * - 显示热榜帖子前十（前三标橙）
 */
export default function SearchDropdown({ open, onClose }: SearchDropdownProps) {
  const [searchHistory, setSearchHistory] = useState<SearchHistoryItem[]>([])
  const [hotPosts, setHotPosts] = useState<HotPost[]>([])

  // 加载搜索历史
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('searchHistory')
      if (stored) {
        try {
          setSearchHistory(JSON.parse(stored))
        } catch (e) {
          console.error('Failed to parse search history:', e)
        }
      }
    }
  }, [])

  // 加载热榜帖子（mock数据）
  useEffect(() => {
    // TODO: 从API获取真实数据
    const mockHotPosts: HotPost[] = [
      { id: 1, title: '今晚 8 点会不会假突破？我给出 3 个证据', hotScore: 98, rank: 1 },
      { id: 2, title: '"不设止损"不是勇敢，是数学不及格', hotScore: 76, rank: 2 },
      { id: 3, title: 'ETH 质押收益到底算不算"无风险"？', hotScore: 65, rank: 3 },
      { id: 4, title: '如何选择你的第一个去中心化交易所 (DEX)？', hotScore: 50, rank: 4 },
      { id: 5, title: '美联储加息周期对加密市场的影响分析', hotScore: 90, rank: 5 },
      { id: 6, title: 'DeFi 协议安全性分析：你需要知道的风险', hotScore: 45, rank: 6 },
      { id: 7, title: 'NFT 市场降温背后的原因分析', hotScore: 40, rank: 7 },
      { id: 8, title: 'Layer 2 解决方案对比：哪个最适合你？', hotScore: 38, rank: 8 },
      { id: 9, title: '加密货币税务指南：2024年最新政策', hotScore: 35, rank: 9 },
      { id: 10, title: 'Web3 钱包安全性最佳实践', hotScore: 32, rank: 10 },
    ]
    setHotPosts(mockHotPosts)
  }, [])

  // 删除单个历史记录
  const handleDeleteHistory = (id: string, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const newHistory = searchHistory.filter((item) => item.id !== id)
    setSearchHistory(newHistory)
    if (typeof window !== 'undefined') {
      localStorage.setItem('searchHistory', JSON.stringify(newHistory))
    }
  }

  // 清空所有历史记录
  const handleClearAllHistory = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setSearchHistory([])
    if (typeof window !== 'undefined') {
      localStorage.removeItem('searchHistory')
    }
  }

  if (!open) return null

  return (
    <Box
      style={{
        position: 'absolute',
        top: 'calc(100% + 8px)',
        left: 0,
        right: 0,
        background: tokens.colors.bg.secondary,
        border: `1px solid ${tokens.colors.border.primary}`,
        borderRadius: tokens.radius.md,
        maxHeight: 600,
        overflowY: 'auto',
        zIndex: tokens.zIndex.dropdown,
        boxShadow: tokens.shadow.md,
      }}
    >
      {/* 搜索历史 */}
      {searchHistory.length > 0 && (
        <Box>
          <Box
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
              borderBottom: `1px solid ${tokens.colors.border.primary}`,
            }}
          >
            <Text size="xs" weight="bold" color="tertiary" style={{ textTransform: 'uppercase' }}>
              搜索历史
            </Text>
            <button
              onClick={handleClearAllHistory}
              style={{
                background: 'transparent',
                border: 'none',
                color: tokens.colors.text.tertiary,
                cursor: 'pointer',
                fontSize: tokens.typography.fontSize.xs,
                padding: 0,
              }}
            >
              清空
            </button>
          </Box>
          <Box>
            {searchHistory.map((item) => (
              <Box
                key={item.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                  borderBottom: `1px solid ${tokens.colors.border.primary}`,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = tokens.colors.bg.tertiary
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent'
                }}
              >
                <Link
                  href={`/search?q=${encodeURIComponent(item.query)}`}
                  style={{ textDecoration: 'none', flex: 1 }}
                  onClick={onClose}
                >
                  <Text size="sm" style={{ color: tokens.colors.text.primary }}>
                    {item.query}
                  </Text>
                </Link>
                <button
                  onClick={(e) => handleDeleteHistory(item.id, e)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: tokens.colors.text.tertiary,
                    cursor: 'pointer',
                    padding: tokens.spacing[1],
                    display: 'flex',
                    alignItems: 'center',
                    marginLeft: tokens.spacing[2],
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.color = tokens.colors.text.secondary
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.color = tokens.colors.text.tertiary
                  }}
                >
                  <CloseIcon size={14} />
                </button>
              </Box>
            ))}
          </Box>
        </Box>
      )}

      {/* 热榜帖子 */}
      <Box>
        <Box
          style={{
            padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
            borderBottom: searchHistory.length > 0 ? `1px solid ${tokens.colors.border.primary}` : 'none',
          }}
        >
          <Text size="xs" weight="bold" color="tertiary" style={{ textTransform: 'uppercase' }}>
            热榜帖子
          </Text>
        </Box>
        <Box>
          {hotPosts.map((post) => (
            <Link
              key={post.id}
              href={`/posts/${post.id}`}
              style={{ textDecoration: 'none' }}
              onClick={onClose}
            >
              <Box
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: tokens.spacing[3],
                  padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                  borderBottom: `1px solid ${tokens.colors.border.primary}`,
                  cursor: 'pointer',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = tokens.colors.bg.tertiary
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent'
                }}
              >
                {/* 排名 - 前三标橙 */}
                <Text
                  size="sm"
                  weight="black"
                  style={{
                    color: post.rank <= 3 ? '#FF9800' : tokens.colors.text.tertiary, // 橙色
                    minWidth: 24,
                    textAlign: 'right',
                  }}
                >
                  {post.rank}
                </Text>
                <Text
                  size="sm"
                  style={{
                    color: tokens.colors.text.primary,
                    flex: 1,
                    lineHeight: 1.5,
                  }}
                >
                  {post.title}
                </Text>
              </Box>
            </Link>
          ))}
        </Box>
      </Box>
    </Box>
  )
}
