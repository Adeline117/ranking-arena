'use client'

import React, { useState, useRef, useEffect } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'
import { useSavedFilters, type FilterConditions, type SavedFilter, FILTER_TEMPLATES } from '@/lib/hooks/useSavedFilters'
import { Bookmark, Plus, Trash2, Pin, Check, ChevronDown, Download, Upload } from 'lucide-react'

// ============================================
// 类型定义
// ============================================

interface SavedFiltersProps {
  /** 当前筛选条件 */
  currentConditions: FilterConditions
  /** 加载筛选时的回调 */
  onLoadFilter: (conditions: FilterConditions) => void
  /** 用户 ID（可选，用于同步） */
  userId?: string | null
}

// ============================================
// 主组件
// ============================================

export default function SavedFilters({
  currentConditions,
  onLoadFilter,
  userId,
}: SavedFiltersProps) {
  const { language } = useLanguage()
  const [isOpen, setIsOpen] = useState(false)
  const [showSaveModal, setShowSaveModal] = useState(false)
  const [filterName, setFilterName] = useState('')
  const [showConfirmDelete, setShowConfirmDelete] = useState<string | null>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  
  const {
    savedFilters,
    activeFilterId,
    saveFilter,
    loadFilter,
    deleteFilter,
    togglePin,
    clearActiveFilter,
    exportFilters,
    importFilters,
    isLoading,
  } = useSavedFilters({ userId })
  
  // 点击外部关闭下拉菜单
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])
  
  // 保存筛选
  const handleSave = () => {
    if (!filterName.trim()) return
    saveFilter(filterName, currentConditions)
    setFilterName('')
    setShowSaveModal(false)
  }
  
  // 加载筛选
  const handleLoad = (id: string) => {
    const conditions = loadFilter(id)
    if (conditions) {
      onLoadFilter(conditions)
      setIsOpen(false)
    }
  }
  
  // 删除筛选
  const handleDelete = (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (showConfirmDelete === id) {
      deleteFilter(id)
      setShowConfirmDelete(null)
    } else {
      setShowConfirmDelete(id)
      // 3秒后自动取消确认状态
      setTimeout(() => setShowConfirmDelete(null), 3000)
    }
  }
  
  // 导出筛选
  const handleExport = () => {
    const json = exportFilters()
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'ranking-arena-filters.json'
    a.click()
    URL.revokeObjectURL(url)
  }
  
  // 导入筛选
  const handleImport = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json'
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (!file) return
      
      const reader = new FileReader()
      reader.onload = (event) => {
        const json = event.target?.result as string
        if (importFilters(json)) {
          alert(language === 'zh' ? '导入成功！' : 'Import successful!')
        } else {
          alert(language === 'zh' ? '导入失败，请检查文件格式' : 'Import failed, please check file format')
        }
      }
      reader.readAsText(file)
    }
    input.click()
  }
  
  // 使用模板
  const handleUseTemplate = (template: typeof FILTER_TEMPLATES[0]) => {
    onLoadFilter(template.conditions)
    clearActiveFilter()
    setIsOpen(false)
  }
  
  const activeFilter = savedFilters.find(f => f.id === activeFilterId)

  return (
    <Box ref={dropdownRef} style={{ position: 'relative' }}>
      {/* 主按钮 */}
      <Box style={{ display: 'flex', gap: tokens.spacing[2] }}>
        {/* 保存当前筛选按钮 */}
        <button
          onClick={() => setShowSaveModal(true)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing[1],
            padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
            borderRadius: tokens.radius.lg,
            border: `1px solid ${tokens.colors.border.primary}`,
            background: tokens.glass.bg.light,
            color: tokens.colors.text.secondary,
            fontSize: tokens.typography.fontSize.sm,
            cursor: 'pointer',
            transition: `all ${tokens.transition.fast}`,
            fontFamily: tokens.typography.fontFamily.sans.join(', '),
          }}
          title={language === 'zh' ? '保存当前筛选' : 'Save current filter'}
        >
          <Plus size={14} />
          <span style={{ display: 'none', ['@media (min-width: 768px)' as string]: { display: 'inline' } }}>
            {language === 'zh' ? '保存' : 'Save'}
          </span>
        </button>
        
        {/* 已保存筛选下拉 */}
        <button
          onClick={() => setIsOpen(!isOpen)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing[2],
            padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
            borderRadius: tokens.radius.lg,
            border: `1px solid ${activeFilterId ? tokens.colors.accent.primary : tokens.colors.border.primary}`,
            background: activeFilterId 
              ? `${tokens.colors.accent.primary}15`
              : tokens.glass.bg.light,
            color: activeFilterId ? tokens.colors.accent.primary : tokens.colors.text.secondary,
            fontSize: tokens.typography.fontSize.sm,
            cursor: 'pointer',
            transition: `all ${tokens.transition.fast}`,
            fontFamily: tokens.typography.fontFamily.sans.join(', '),
            minWidth: 120,
          }}
        >
          <Bookmark size={14} fill={activeFilterId ? tokens.colors.accent.primary : 'none'} />
          <span style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {activeFilter?.name || (language === 'zh' ? '我的筛选' : 'My Filters')}
          </span>
          <ChevronDown 
            size={14} 
            style={{ 
              transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
              transition: 'transform 0.2s ease',
            }} 
          />
        </button>
      </Box>
      
      {/* 下拉菜单 */}
      {isOpen && (
        <Box
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: tokens.spacing[2],
            minWidth: 280,
            maxWidth: 320,
            background: tokens.colors.bg.primary,
            border: `1px solid ${tokens.colors.border.primary}`,
            borderRadius: tokens.radius.xl,
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.2)',
            zIndex: 100,
            overflow: 'hidden',
          }}
        >
          {/* 已保存的筛选 */}
          {savedFilters.length > 0 && (
            <>
              <Box style={{ 
                padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                borderBottom: `1px solid ${tokens.colors.border.primary}`,
                background: tokens.colors.bg.secondary,
              }}>
                <Text size="xs" weight="bold" color="tertiary">
                  {language === 'zh' ? '已保存' : 'SAVED'} ({savedFilters.length})
                </Text>
              </Box>
              <Box style={{ maxHeight: 200, overflowY: 'auto' }}>
                {savedFilters.map((filter) => (
                  <FilterItem
                    key={filter.id}
                    filter={filter}
                    isActive={activeFilterId === filter.id}
                    isConfirmingDelete={showConfirmDelete === filter.id}
                    onLoad={() => handleLoad(filter.id)}
                    onDelete={(e) => handleDelete(filter.id, e)}
                    onTogglePin={(e) => {
                      e.stopPropagation()
                      togglePin(filter.id)
                    }}
                    language={language}
                  />
                ))}
              </Box>
            </>
          )}
          
          {/* 筛选模板 */}
          <Box style={{ 
            padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
            borderTop: savedFilters.length > 0 ? `1px solid ${tokens.colors.border.primary}` : 'none',
            borderBottom: `1px solid ${tokens.colors.border.primary}`,
            background: tokens.colors.bg.secondary,
          }}>
            <Text size="xs" weight="bold" color="tertiary">
              {language === 'zh' ? '快速筛选' : 'QUICK FILTERS'}
            </Text>
          </Box>
          <Box>
            {FILTER_TEMPLATES.map((template, idx) => (
              <button
                key={idx}
                onClick={() => handleUseTemplate(template)}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: tokens.spacing[2],
                  padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                  border: 'none',
                  background: 'transparent',
                  color: tokens.colors.text.primary,
                  fontSize: tokens.typography.fontSize.sm,
                  cursor: 'pointer',
                  transition: `background ${tokens.transition.fast}`,
                  textAlign: 'left',
                  fontFamily: tokens.typography.fontFamily.sans.join(', '),
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = tokens.colors.bg.secondary}
                onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
              >
                <Text size="sm">{template.name}</Text>
              </button>
            ))}
          </Box>
          
          {/* 底部操作 */}
          <Box style={{ 
            display: 'flex',
            gap: tokens.spacing[2],
            padding: tokens.spacing[3],
            borderTop: `1px solid ${tokens.colors.border.primary}`,
            background: tokens.colors.bg.secondary,
          }}>
            <button
              onClick={handleExport}
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: tokens.spacing[1],
                padding: tokens.spacing[2],
                borderRadius: tokens.radius.md,
                border: `1px solid ${tokens.colors.border.primary}`,
                background: 'transparent',
                color: tokens.colors.text.tertiary,
                fontSize: tokens.typography.fontSize.xs,
                cursor: 'pointer',
                fontFamily: tokens.typography.fontFamily.sans.join(', '),
              }}
              title={language === 'zh' ? '导出筛选' : 'Export filters'}
            >
              <Download size={12} />
              {language === 'zh' ? '导出' : 'Export'}
            </button>
            <button
              onClick={handleImport}
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: tokens.spacing[1],
                padding: tokens.spacing[2],
                borderRadius: tokens.radius.md,
                border: `1px solid ${tokens.colors.border.primary}`,
                background: 'transparent',
                color: tokens.colors.text.tertiary,
                fontSize: tokens.typography.fontSize.xs,
                cursor: 'pointer',
                fontFamily: tokens.typography.fontFamily.sans.join(', '),
              }}
              title={language === 'zh' ? '导入筛选' : 'Import filters'}
            >
              <Upload size={12} />
              {language === 'zh' ? '导入' : 'Import'}
            </button>
            {activeFilterId && (
              <button
                onClick={() => {
                  clearActiveFilter()
                  setIsOpen(false)
                }}
                style={{
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: tokens.spacing[1],
                  padding: tokens.spacing[2],
                  borderRadius: tokens.radius.md,
                  border: 'none',
                  background: tokens.colors.accent.error + '20',
                  color: tokens.colors.accent.error,
                  fontSize: tokens.typography.fontSize.xs,
                  cursor: 'pointer',
                  fontFamily: tokens.typography.fontFamily.sans.join(', '),
                }}
              >
                {language === 'zh' ? '清除' : 'Clear'}
              </button>
            )}
          </Box>
        </Box>
      )}
      
      {/* 保存筛选模态框 */}
      {showSaveModal && (
        <SaveFilterModal
          filterName={filterName}
          onFilterNameChange={setFilterName}
          onSave={handleSave}
          onCancel={() => {
            setShowSaveModal(false)
            setFilterName('')
          }}
          language={language}
        />
      )}
    </Box>
  )
}

// ============================================
// 子组件
// ============================================

function FilterItem({
  filter,
  isActive,
  isConfirmingDelete,
  onLoad,
  onDelete,
  onTogglePin,
  language,
}: {
  filter: SavedFilter
  isActive: boolean
  isConfirmingDelete: boolean
  onLoad: () => void
  onDelete: (e: React.MouseEvent) => void
  onTogglePin: (e: React.MouseEvent) => void
  language: string
}) {
  return (
    <button
      onClick={onLoad}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacing[2],
        padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
        border: 'none',
        background: isActive ? `${tokens.colors.accent.primary}10` : 'transparent',
        color: tokens.colors.text.primary,
        fontSize: tokens.typography.fontSize.sm,
        cursor: 'pointer',
        transition: `background ${tokens.transition.fast}`,
        textAlign: 'left',
        fontFamily: tokens.typography.fontFamily.sans.join(', '),
        borderLeft: isActive ? `3px solid ${tokens.colors.accent.primary}` : '3px solid transparent',
      }}
      onMouseEnter={(e) => {
        if (!isActive) e.currentTarget.style.background = tokens.colors.bg.secondary
      }}
      onMouseLeave={(e) => {
        if (!isActive) e.currentTarget.style.background = 'transparent'
      }}
    >
      {/* 固定图标 */}
      {filter.isPinned && (
        <Pin size={12} style={{ color: tokens.colors.accent.warning, flexShrink: 0 }} />
      )}
      
      {/* 名称和使用次数 */}
      <Box style={{ flex: 1, minWidth: 0 }}>
        <Text 
          size="sm" 
          weight={isActive ? 'bold' : 'medium'}
          style={{ 
            overflow: 'hidden', 
            textOverflow: 'ellipsis', 
            whiteSpace: 'nowrap',
            color: isActive ? tokens.colors.accent.primary : tokens.colors.text.primary,
          }}
        >
          {filter.name}
        </Text>
        <Text size="xs" color="tertiary">
          {language === 'zh' ? `使用 ${filter.useCount} 次` : `Used ${filter.useCount} times`}
        </Text>
      </Box>
      
      {/* 操作按钮 */}
      <Box style={{ display: 'flex', gap: tokens.spacing[1], flexShrink: 0 }}>
        <button
          onClick={onTogglePin}
          style={{
            padding: tokens.spacing[1],
            borderRadius: tokens.radius.sm,
            border: 'none',
            background: 'transparent',
            color: filter.isPinned ? tokens.colors.accent.warning : tokens.colors.text.tertiary,
            cursor: 'pointer',
            opacity: 0.6,
            transition: 'opacity 0.2s',
          }}
          onMouseEnter={(e) => e.currentTarget.style.opacity = '1'}
          onMouseLeave={(e) => e.currentTarget.style.opacity = '0.6'}
          title={filter.isPinned 
            ? (language === 'zh' ? '取消固定' : 'Unpin') 
            : (language === 'zh' ? '固定' : 'Pin')}
        >
          <Pin size={14} fill={filter.isPinned ? tokens.colors.accent.warning : 'none'} />
        </button>
        
        <button
          onClick={onDelete}
          style={{
            padding: tokens.spacing[1],
            borderRadius: tokens.radius.sm,
            border: 'none',
            background: isConfirmingDelete ? tokens.colors.accent.error : 'transparent',
            color: isConfirmingDelete ? '#fff' : tokens.colors.text.tertiary,
            cursor: 'pointer',
            opacity: isConfirmingDelete ? 1 : 0.6,
            transition: 'all 0.2s',
          }}
          onMouseEnter={(e) => e.currentTarget.style.opacity = '1'}
          onMouseLeave={(e) => {
            if (!isConfirmingDelete) e.currentTarget.style.opacity = '0.6'
          }}
          title={isConfirmingDelete 
            ? (language === 'zh' ? '确认删除？' : 'Confirm delete?')
            : (language === 'zh' ? '删除' : 'Delete')}
        >
          {isConfirmingDelete ? <Check size={14} /> : <Trash2 size={14} />}
        </button>
      </Box>
      
      {/* 激活标记 */}
      {isActive && (
        <Check size={14} style={{ color: tokens.colors.accent.primary, flexShrink: 0 }} />
      )}
    </button>
  )
}

function SaveFilterModal({
  filterName,
  onFilterNameChange,
  onSave,
  onCancel,
  language,
}: {
  filterName: string
  onFilterNameChange: (name: string) => void
  onSave: () => void
  onCancel: () => void
  language: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  
  useEffect(() => {
    inputRef.current?.focus()
  }, [])
  
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && filterName.trim()) {
      onSave()
    } else if (e.key === 'Escape') {
      onCancel()
    }
  }

  return (
    <Box
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.5)',
        backdropFilter: 'blur(4px)',
        zIndex: 1000,
      }}
      onClick={onCancel}
    >
      <Box
        style={{
          background: tokens.colors.bg.primary,
          borderRadius: tokens.radius.xl,
          padding: tokens.spacing[6],
          width: '100%',
          maxWidth: 360,
          boxShadow: '0 16px 64px rgba(0, 0, 0, 0.3)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[4] }}>
          {language === 'zh' ? '保存筛选条件' : 'Save Filter'}
        </Text>
        
        <input
          ref={inputRef}
          type="text"
          value={filterName}
          onChange={(e) => onFilterNameChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={language === 'zh' ? '输入筛选名称...' : 'Enter filter name...'}
          style={{
            width: '100%',
            padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
            borderRadius: tokens.radius.lg,
            border: `1px solid ${tokens.colors.border.primary}`,
            background: tokens.colors.bg.secondary,
            color: tokens.colors.text.primary,
            fontSize: tokens.typography.fontSize.base,
            outline: 'none',
            fontFamily: tokens.typography.fontFamily.sans.join(', '),
          }}
        />
        
        <Box style={{ display: 'flex', gap: tokens.spacing[3], marginTop: tokens.spacing[4] }}>
          <button
            onClick={onCancel}
            style={{
              flex: 1,
              padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
              borderRadius: tokens.radius.lg,
              border: `1px solid ${tokens.colors.border.primary}`,
              background: 'transparent',
              color: tokens.colors.text.secondary,
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: tokens.typography.fontWeight.medium,
              cursor: 'pointer',
              fontFamily: tokens.typography.fontFamily.sans.join(', '),
            }}
          >
            {language === 'zh' ? '取消' : 'Cancel'}
          </button>
          <button
            onClick={onSave}
            disabled={!filterName.trim()}
            style={{
              flex: 1,
              padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
              borderRadius: tokens.radius.lg,
              border: 'none',
              background: filterName.trim()
                ? `linear-gradient(135deg, ${tokens.colors.accent.primary}, ${tokens.colors.accent.brand})`
                : tokens.colors.bg.tertiary,
              color: filterName.trim() ? '#fff' : tokens.colors.text.tertiary,
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: tokens.typography.fontWeight.bold,
              cursor: filterName.trim() ? 'pointer' : 'not-allowed',
              fontFamily: tokens.typography.fontFamily.sans.join(', '),
            }}
          >
            {language === 'zh' ? '保存' : 'Save'}
          </button>
        </Box>
      </Box>
    </Box>
  )
}
