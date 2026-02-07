'use client'

import React, { useState, useEffect, useCallback, useRef } from 'react'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import { Box, Text, Button } from '@/app/components/base'
import Card from '@/app/components/ui/Card'
import Pagination from '@/app/components/ui/Pagination'
import { useToast } from '@/app/components/ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { uiLogger } from '@/lib/utils/logger'
import { formatTimeAgo } from '@/lib/utils/date'

// Flash News 类型定义
interface FlashNews {
  id: string
  title: string
  title_zh?: string
  title_en?: string
  content?: string
  source: string
  source_url?: string
  category: 'crypto' | 'macro' | 'defi' | 'regulation' | 'market'
  importance: 'breaking' | 'important' | 'normal'
  tags: string[]
  published_at: string
  created_at: string
}

interface FlashNewsResponse {
  news: FlashNews[]
  pagination: {
    page: number
    limit: number
    total: number
    totalPages: number
    hasNext: boolean
    hasPrev: boolean
  }
}

// 类别配置
const CATEGORIES = [
  { key: 'all', label: '全部', label_en: 'All' },
  { key: 'crypto', label: '加密货币', label_en: 'Crypto' },
  { key: 'macro', label: '宏观经济', label_en: 'Macro' },
  { key: 'defi', label: 'DeFi', label_en: 'DeFi' },
  { key: 'regulation', label: '监管政策', label_en: 'Regulation' },
  { key: 'market', label: '市场动态', label_en: 'Market' },
]

// 重要性配置
const IMPORTANCE_CONFIG = {
  breaking: { 
    color: '#ef4444', 
    bg: '#fef2f2', 
    label: '突发', 
    label_en: 'Breaking',
    icon: '🔥'
  },
  important: { 
    color: '#f97316', 
    bg: '#fff7ed', 
    label: '重要', 
    label_en: 'Important',
    icon: '⚡'
  },
  normal: { 
    color: '#6b7280', 
    bg: '#f9fafb', 
    label: '一般', 
    label_en: 'Normal',
    icon: ''
  },
}

// 类别颜色配置
const CATEGORY_COLORS = {
  crypto: '#f59e0b',
  macro: '#3b82f6',
  defi: '#10b981',
  regulation: '#8b5cf6',
  market: '#06b6d4',
}

export default function FlashNewsPage() {
  const { language } = useLanguage()
  const { showToast } = useToast()
  
  // State
  const [news, setNews] = useState<FlashNews[]>([])
  const [loading, setLoading] = useState(true)
  const [currentPage, setCurrentPage] = useState(1)
  const [selectedCategory, setSelectedCategory] = useState('all')
  const [pagination, setPagination] = useState({
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 1,
    hasNext: false,
    hasPrev: false,
  })

  // 获取快讯数据
  const fetchNews = useCallback(async (page = 1, category = 'all') => {
    try {
      setLoading(true)
      
      const params = new URLSearchParams({
        page: page.toString(),
        limit: '20',
      })
      
      if (category !== 'all') {
        params.append('category', category)
      }
      
      const response = await fetch(`/api/flash-news?${params}`)
      
      if (!response.ok) {
        throw new Error('Failed to fetch news')
      }
      
      const data: FlashNewsResponse = await response.json()
      
      setNews(data.news)
      setPagination(data.pagination)
    } catch (error) {
      console.error('获取快讯失败:', error)
      showToast('获取快讯失败', 'error')
    } finally {
      setLoading(false)
    }
  }, [showToast])

  // 初始加载
  useEffect(() => {
    fetchNews(currentPage, selectedCategory)
  }, [fetchNews, currentPage, selectedCategory])

  // 处理分类切换
  const handleCategoryChange = (category: string) => {
    setSelectedCategory(category)
    setCurrentPage(1) // 重置到第一页
  }

  // 处理页码切换
  const handlePageChange = (page: number) => {
    setCurrentPage(page)
  }

  // 获取标题（根据语言）
  const getNewsTitle = (newsItem: FlashNews) => {
    if (language === 'zh') {
      return newsItem.title_zh || newsItem.title
    }
    return newsItem.title_en || newsItem.title
  }

  // 格式化时间
  const formatPublishedTime = (timestamp: string) => {
    const date = new Date(timestamp)
    const now = new Date()
    const diff = now.getTime() - date.getTime()
    
    // 如果是今天，显示具体时间
    if (diff < 24 * 60 * 60 * 1000) {
      return date.toLocaleTimeString('zh-CN', { 
        hour: '2-digit', 
        minute: '2-digit' 
      })
    }
    
    // 超过一天，显示日期
    return date.toLocaleDateString('zh-CN', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  }

  return (
    <Box
      style={{
        background: tokens.colors.bg.primary,
        minHeight: '100vh',
        color: tokens.colors.text.primary,
      }}
    >
      <TopNav />
      
      <Box 
        style={{ 
          maxWidth: '800px', 
          margin: '0 auto', 
          padding: `${tokens.spacing[4]} ${tokens.spacing[3]}` 
        }}
      >
        {/* 标题区域 */}
        <Box style={{ marginBottom: tokens.spacing[5] }}>
          <Text 
            style={{ 
              fontSize: '28px', 
              fontWeight: '700',
              marginBottom: tokens.spacing[2] 
            }}
          >
            {language === 'zh' ? '快讯中心' : 'Flash News'}
          </Text>
          <Text style={{ color: tokens.colors.text.secondary, fontSize: '16px' }}>
            {language === 'zh' 
              ? '实时跟踪加密货币、宏观经济、金融市场动态'
              : 'Real-time updates on crypto, macro, and financial markets'
            }
          </Text>
        </Box>

        {/* 分类筛选 */}
        <Box 
          style={{ 
            marginBottom: tokens.spacing[4],
            display: 'flex',
            flexWrap: 'wrap',
            gap: tokens.spacing[2],
          }}
        >
          {CATEGORIES.map((category) => (
            <Button
              key={category.key}
              variant={selectedCategory === category.key ? "primary" : "secondary"}
              size="sm"
              onClick={() => handleCategoryChange(category.key)}
              style={{
                border: selectedCategory === category.key 
                  ? `2px solid ${tokens.colors.accent.primary}` 
                  : `1px solid ${tokens.colors.border.primary}`,
                background: selectedCategory === category.key 
                  ? tokens.colors.accent.primary 
                  : 'transparent',
              }}
            >
              {language === 'zh' ? category.label : category.label_en}
            </Button>
          ))}
        </Box>

        {/* 新闻时间线 */}
        <div style={{ transition: 'opacity 0.3s ease', opacity: loading ? 0.5 : 1 }}>
        {loading && news.length === 0 ? (
          <Box 
            style={{ 
              textAlign: 'center', 
              padding: tokens.spacing[5],
              color: tokens.colors.text.secondary 
            }}
          >
            <Text>{language === 'zh' ? '加载中...' : 'Loading...'}</Text>
          </Box>
        ) : news.length === 0 ? (
          <Box 
            style={{ 
              textAlign: 'center', 
              padding: tokens.spacing[5],
              color: tokens.colors.text.secondary 
            }}
          >
            <Text>{language === 'zh' ? '暂无快讯' : 'No news available'}</Text>
          </Box>
        ) : (
          <Box>
            {/* 新闻列表 */}
            <Box style={{ marginBottom: tokens.spacing[5] }}>
              {news.map((newsItem, index) => {
                const importanceConfig = IMPORTANCE_CONFIG[newsItem.importance]
                const categoryColor = CATEGORY_COLORS[newsItem.category] || tokens.colors.text.secondary
                
                return (
                  <Box 
                    key={newsItem.id}
                    style={{
                      display: 'flex',
                      marginBottom: tokens.spacing[4],
                      borderLeft: index === 0 ? 'none' : `2px solid ${tokens.colors.border.primary}`,
                      paddingLeft: index === 0 ? '0' : tokens.spacing[3],
                      position: 'relative',
                    }}
                  >
                    {/* 时间轴圆点 */}
                    {index > 0 && (
                      <Box
                        style={{
                          position: 'absolute',
                          left: '-6px',
                          top: tokens.spacing[2],
                          width: '10px',
                          height: '10px',
                          borderRadius: '50%',
                          background: importanceConfig.color,
                          border: `2px solid ${tokens.colors.bg.primary}`,
                        }}
                      />
                    )}

                    <Box style={{ flex: 1 }}>
                      <Card 
                        style={{ 
                          padding: tokens.spacing[3],
                          background: tokens.colors.bg.secondary,
                          border: `1px solid ${tokens.colors.border.primary}`,
                          borderRadius: tokens.radius.md,
                          position: 'relative',
                          overflow: 'hidden',
                        }}
                      >
                        {/* 重要性标签 */}
                        {newsItem.importance !== 'normal' && (
                          <Box
                            style={{
                              position: 'absolute',
                              top: 0,
                              left: 0,
                              background: importanceConfig.color,
                              color: 'white',
                              padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                              fontSize: '12px',
                              fontWeight: '600',
                              borderRadius: `0 0 ${tokens.radius.sm} 0`,
                            }}
                          >
                            {importanceConfig.icon} {language === 'zh' ? importanceConfig.label : importanceConfig.label_en}
                          </Box>
                        )}

                        {/* 新闻内容 */}
                        <Box style={{ paddingTop: newsItem.importance !== 'normal' ? tokens.spacing[4] : '0' }}>
                          {/* 时间和分类 */}
                          <Box 
                            style={{ 
                              display: 'flex', 
                              alignItems: 'center', 
                              justifyContent: 'space-between',
                              marginBottom: tokens.spacing[2],
                            }}
                          >
                            <Text 
                              style={{ 
                                color: tokens.colors.text.tertiary,
                                fontSize: '14px',
                                fontWeight: '500',
                              }}
                            >
                              {formatPublishedTime(newsItem.published_at)}
                            </Text>
                            
                            <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1] }}>
                              <Box
                                style={{
                                  background: categoryColor,
                                  color: 'white',
                                  padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                                  borderRadius: tokens.radius.sm,
                                  fontSize: '12px',
                                  fontWeight: '600',
                                }}
                              >
                                {CATEGORIES.find(c => c.key === newsItem.category)?.[language === 'zh' ? 'label' : 'label_en']}
                              </Box>
                            </Box>
                          </Box>

                          {/* 标题 */}
                          <Text 
                            style={{ 
                              fontSize: '16px',
                              fontWeight: '600',
                              lineHeight: '1.5',
                              marginBottom: tokens.spacing[2],
                              color: tokens.colors.text.primary,
                            }}
                          >
                            {getNewsTitle(newsItem)}
                          </Text>

                          {/* 内容摘要 */}
                          {newsItem.content && (
                            <Text 
                              style={{ 
                                color: tokens.colors.text.secondary,
                                lineHeight: '1.5',
                                marginBottom: tokens.spacing[2],
                                fontSize: '14px',
                              }}
                            >
                              {newsItem.content}
                            </Text>
                          )}

                          {/* 来源和标签 */}
                          <Box 
                            style={{ 
                              display: 'flex', 
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              flexWrap: 'wrap',
                              gap: tokens.spacing[2],
                            }}
                          >
                            <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1] }}>
                              <Text style={{ 
                                color: tokens.colors.text.tertiary, 
                                fontSize: '12px',
                                fontWeight: '500',
                              }}>
                                {language === 'zh' ? '来源:' : 'Source:'}
                              </Text>
                              {newsItem.source_url ? (
                                <a 
                                  href={newsItem.source_url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  style={{
                                    color: tokens.colors.accent.primary,
                                    textDecoration: 'none',
                                    fontSize: '12px',
                                    fontWeight: '500',
                                  }}
                                >
                                  {newsItem.source}
                                </a>
                              ) : (
                                <Text style={{ 
                                  color: tokens.colors.text.secondary, 
                                  fontSize: '12px',
                                  fontWeight: '500',
                                }}>
                                  {newsItem.source}
                                </Text>
                              )}
                            </Box>

                            {/* 标签 */}
                            {newsItem.tags && newsItem.tags.length > 0 && (
                              <Box style={{ display: 'flex', gap: tokens.spacing[1], flexWrap: 'wrap' }}>
                                {newsItem.tags.slice(0, 3).map((tag, tagIndex) => (
                                  <Box
                                    key={tagIndex}
                                    style={{
                                      background: tokens.colors.bg.tertiary,
                                      color: tokens.colors.text.tertiary,
                                      padding: `2px ${tokens.spacing[1]}`,
                                      borderRadius: tokens.radius.sm,
                                      fontSize: '10px',
                                      fontWeight: '500',
                                    }}
                                  >
                                    #{tag}
                                  </Box>
                                ))}
                              </Box>
                            )}
                          </Box>
                        </Box>
                      </Card>
                    </Box>
                  </Box>
                )
              })}
            </Box>

            {/* 分页器 */}
            {pagination.totalPages > 1 && (
              <Pagination
                currentPage={currentPage}
                totalPages={pagination.totalPages}
                onPageChange={handlePageChange}
              />
            )}
          </Box>
        )}
        </div>
      </Box>
    </Box>
  )
}