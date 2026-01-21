'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useLanguage } from '../Utils/LanguageProvider'

// ============================================
// 类型定义
// ============================================

interface SearchSuggestion {
  type: 'trader' | 'symbol' | 'keyword'
  value: string
  label: string
  subLabel?: string
  avatar?: string
}

interface HotSearch {
  keyword: string
  count: number
  trend: 'up' | 'down' | 'stable'
}

// ============================================
// 模拟数据（实际应从 API 获取）
// ============================================

const MOCK_HOT_SEARCHES: HotSearch[] = [
  { keyword: 'BTC', count: 12500, trend: 'up' },
  { keyword: 'ETH', count: 8900, trend: 'up' },
  { keyword: '高收益交易员', count: 6700, trend: 'stable' },
  { keyword: 'Binance Top', count: 5400, trend: 'down' },
  { keyword: 'SOL', count: 4200, trend: 'up' },
  { keyword: '低回撤策略', count: 3800, trend: 'stable' },
]

const MOCK_RECENT_SEARCHES = ['CryptoKing', 'PEPE', 'BTC 大户']

// ============================================
// 搜索建议 Hook - 从数据库获取真实交易员数据
// ============================================

function useSearchSuggestions(query: string) {
  const [suggestions, setSuggestions] = useState<SearchSuggestion[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!query.trim()) {
      setSuggestions([])
      return
    }

    const abortController = new AbortController()
    setLoading(true)

    // 防抖 200ms
    const timer = setTimeout(async () => {
      try {
        // 调用 traders API 并根据 handle 过滤
        const response = await fetch('/api/traders?timeRange=90D', {
          signal: abortController.signal,
        })

        if (!response.ok) {
          throw new Error('Failed to fetch traders')
        }

        const data = await response.json()
        const traders = data.traders || []

        // 过滤匹配的交易员（模糊匹配 handle）
        const queryLower = query.toLowerCase()
        const matchedTraders = traders
          .filter((t: { handle: string }) =>
            t.handle?.toLowerCase().includes(queryLower)
          )
          .slice(0, 5)  // 最多显示 5 个建议
          .map((t: { handle: string; source: string; roi: number; avatar?: string }) => ({
            type: 'trader' as const,
            value: t.handle,
            label: `@${t.handle}`,
            subLabel: `${t.source} · ROI ${t.roi >= 0 ? '+' : ''}${t.roi.toFixed(1)}%`,
            avatar: t.avatar,
          }))

        // 如果没有匹配的交易员，添加关键词搜索建议
        const finalSuggestions: SearchSuggestion[] = matchedTraders.length > 0
          ? matchedTraders
          : [
              { type: 'keyword', value: query, label: query, subLabel: '' },
            ]

        // 如果有匹配的交易员，也添加关键词搜索选项
        if (matchedTraders.length > 0 && matchedTraders.length < 5) {
          finalSuggestions.push({
            type: 'keyword',
            value: query,
            label: `${query}`,
            subLabel: '',
          })
        }

        setSuggestions(finalSuggestions)
      } catch (error) {
        if ((error as Error).name !== 'AbortError') {
          console.error('Search suggestions error:', error)
          // 出错时显示关键词搜索建议
          setSuggestions([
            { type: 'keyword', value: query, label: query, subLabel: '' },
          ])
        }
      } finally {
        setLoading(false)
      }
    }, 200)

    return () => {
      clearTimeout(timer)
      abortController.abort()
    }
  }, [query])

  return { suggestions, loading }
}

// ============================================
// 主组件
// ============================================

interface EnhancedSearchProps {
  placeholder?: string
  autoFocus?: boolean
  onSearch?: (query: string) => void
  className?: string
}

export function EnhancedSearch({
  placeholder,
  autoFocus = false,
  onSearch,
  className = '',
}: EnhancedSearchProps) {
  const router = useRouter()
  const { t } = useLanguage()
  const defaultPlaceholder = placeholder || t('searchTraders')
  const inputRef = useRef<HTMLInputElement>(null)
  
  const [query, setQuery] = useState('')
  const [isFocused, setIsFocused] = useState(false)
  const [recentSearches, setRecentSearches] = useState<string[]>([])
  
  const { suggestions, loading } = useSearchSuggestions(query)
  const showDropdown = isFocused && (query.length > 0 || recentSearches.length > 0)

  // 加载历史搜索
  useEffect(() => {
    const stored = localStorage.getItem('ranking-arena-recent-searches')
    if (stored) {
      try {
        setRecentSearches(JSON.parse(stored).slice(0, 5))
      } catch {
        setRecentSearches(MOCK_RECENT_SEARCHES)
      }
    } else {
      setRecentSearches(MOCK_RECENT_SEARCHES)
    }
  }, [])

  // 保存搜索历史
  const saveToHistory = useCallback((searchQuery: string) => {
    const newHistory = [searchQuery, ...recentSearches.filter(s => s !== searchQuery)].slice(0, 10)
    setRecentSearches(newHistory)
    localStorage.setItem('ranking-arena-recent-searches', JSON.stringify(newHistory))
  }, [recentSearches])

  // 执行搜索
  const handleSearch = useCallback((searchQuery: string) => {
    if (!searchQuery.trim()) return
    
    saveToHistory(searchQuery)
    setQuery('')
    setIsFocused(false)
    
    if (onSearch) {
      onSearch(searchQuery)
    } else {
      router.push(`/search?q=${encodeURIComponent(searchQuery)}`)
    }
  }, [router, onSearch, saveToHistory])

  // 清除历史
  const clearHistory = useCallback(() => {
    setRecentSearches([])
    localStorage.removeItem('ranking-arena-recent-searches')
  }, [])

  // 点击建议
  const handleSuggestionClick = useCallback((suggestion: SearchSuggestion) => {
    if (suggestion.type === 'trader') {
      router.push(`/trader/${encodeURIComponent(suggestion.value)}`)
    } else {
      handleSearch(suggestion.value)
    }
  }, [router, handleSearch])

  // 键盘事件
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSearch(query)
    } else if (e.key === 'Escape') {
      setIsFocused(false)
      inputRef.current?.blur()
    }
  }, [query, handleSearch])

  return (
    <div className={`relative ${className}`}>
      {/* 搜索输入框 */}
      <div className={`relative flex items-center bg-[var(--color-bg-tertiary)] rounded-xl border transition-all duration-200 ${
        isFocused 
          ? 'border-[var(--color-accent-primary)] shadow-lg shadow-[var(--color-accent-primary)]/10' 
          : 'border-[var(--color-border-primary)]'
      }`}>
        <div className="pl-4 text-[var(--color-text-tertiary)]">
          <SearchIcon />
        </div>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setTimeout(() => setIsFocused(false), 200)}
          onKeyDown={handleKeyDown}
          placeholder={defaultPlaceholder}
          autoFocus={autoFocus}
          className="flex-1 bg-transparent px-3 py-3 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:outline-none"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery('')}
            className="pr-4 text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]"
          >
            <ClearIcon />
          </button>
        )}
      </div>

      {/* 下拉面板 */}
      {showDropdown && (
        <div className="absolute top-full left-0 right-0 mt-2 bg-[var(--color-bg-secondary)] border border-[var(--color-border-primary)] rounded-xl shadow-xl overflow-hidden z-50">
          {/* 搜索建议 */}
          {query && suggestions.length > 0 && (
            <div className="p-2">
              {loading ? (
                <div className="py-4 text-center text-sm text-[var(--color-text-tertiary)]">
                  {t('searching')}
                </div>
              ) : (
                suggestions.map((suggestion, idx) => (
                  <button
                    key={idx}
                    onClick={() => handleSuggestionClick(suggestion)}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-[var(--color-bg-tertiary)] transition-colors text-left"
                  >
                    <div className="w-8 h-8 rounded-full bg-[var(--color-bg-tertiary)] flex items-center justify-center text-xs font-bold text-[var(--color-text-tertiary)]">
                      {suggestion.type === 'trader' && 'T'}
                      {suggestion.type === 'symbol' && 'S'}
                      {suggestion.type === 'keyword' && 'K'}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-[var(--color-text-primary)] truncate">
                        {suggestion.label}
                      </div>
                      {suggestion.subLabel && (
                        <div className="text-xs text-[var(--color-text-tertiary)] truncate">
                          {suggestion.subLabel}
                        </div>
                      )}
                    </div>
                  </button>
                ))
              )}
            </div>
          )}

          {/* 历史搜索 */}
          {!query && recentSearches.length > 0 && (
            <div className="p-3 border-b border-[var(--color-border-primary)]">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-[var(--color-text-tertiary)]">{t('searchHistory')}</span>
                <button
                  onClick={clearHistory}
                  className="text-xs text-[var(--color-text-tertiary)] hover:text-[var(--color-error)]"
                >
                  {t('clear')}
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {recentSearches.map((term, idx) => (
                  <button
                    key={idx}
                    onClick={() => handleSearch(term)}
                    className="px-3 py-1.5 bg-[var(--color-bg-tertiary)] rounded-full text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] transition-colors"
                  >
                    {term}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 热门搜索 */}
          {!query && (
            <div className="p-3">
              <div className="text-xs font-semibold text-[var(--color-text-tertiary)] mb-2">{t('hotSearches')}</div>
              <div className="space-y-1">
                {MOCK_HOT_SEARCHES.map((hot, idx) => (
                  <button
                    key={idx}
                    onClick={() => handleSearch(hot.keyword)}
                    className="w-full flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-[var(--color-bg-tertiary)] transition-colors"
                  >
                    <span className={`w-5 text-xs font-bold ${idx < 3 ? 'text-[var(--color-error)]' : 'text-[var(--color-text-tertiary)]'}`}>
                      {idx + 1}
                    </span>
                    <span className="flex-1 text-sm text-[var(--color-text-primary)] text-left">
                      {hot.keyword}
                    </span>
                    <span className="text-xs text-[var(--color-text-tertiary)]">
                      {hot.trend === 'up' && '↑'}
                      {hot.trend === 'down' && '↓'}
                      {hot.trend === 'stable' && '—'}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ============================================
// 图标
// ============================================

function SearchIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  )
}

function ClearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

export default EnhancedSearch
