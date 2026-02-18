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
  const { t, language } = useLanguage()
  const [isOpen, setIsOpen] = useState(false)
  const [showSaveModal, setShowSaveModal] = useState(false)
  const [filterName, setFilterName] = useState('')
  const [showConfirmDelete, setShowConfirmDelete] = useState<string | null>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  
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
    isLoading: _isLoading,
  } = useSavedFilters({ userId })
  
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    
    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
    }
  }, [])
  
  const handleSave = () => {
    if (!filterName.trim()) return
    saveFilter(filterName, currentConditions)
    setFilterName('')
    setShowSaveModal(false)
  }
  
  const handleLoad = (id: string) => {
    const conditions = loadFilter(id)
    if (conditions) {
      onLoadFilter(conditions)
      setIsOpen(false)
    }
  }
  
  const handleDelete = (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (showConfirmDelete === id) {
      deleteFilter(id)
      setShowConfirmDelete(null)
    } else {
      setShowConfirmDelete(id)
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
      confirmTimerRef.current = setTimeout(() => setShowConfirmDelete(null), 3000)
    }
  }
  
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
          alert(t('importSuccessful'))
        } else {
          alert(t('importFailedFormat'))
        }
      }
      reader.readAsText(file)
    }
    input.click()
  }
  
  const handleUseTemplate = (template: typeof FILTER_TEMPLATES[0]) => {
    onLoadFilter(template.conditions)
    clearActiveFilter()
    setIsOpen(false)
  }
  
  const activeFilter = savedFilters.find(f => f.id === activeFilterId)

  return (
    <div ref={dropdownRef} style={{ position: 'relative' }}>
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
          title={t('saveCurrentFilter')}
        >
          <Plus size={14} />
          <span style={{ display: 'none', ['@media (min-width: 768px)' as string]: { display: 'inline' } }}>
            {t('saveLabel')}
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
            {activeFilter?.name || t('myFiltersLabel')}
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
            minWidth: 'min(280px, calc(100vw - 32px))',
            maxWidth: 'min(320px, calc(100vw - 32px))',
            background: tokens.colors.bg.primary,
            border: `1px solid ${tokens.colors.border.primary}`,
            borderRadius: tokens.radius.xl,
            boxShadow: tokens.shadow.lg,
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
                  {t('savedLabel')} ({savedFilters.length})
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
                    t={t}
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
              {t('quickFiltersLabel')}
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
              title={t('exportFiltersTitle')}
            >
              <Download size={12} />
              {t('exportFiltersLabel')}
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
              title={t('importFiltersTitle')}
            >
              <Upload size={12} />
              {t('importFiltersLabel')}
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
                {t('clearFilterLabel')}
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
          t={t}
        />
      )}
    </div>
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
  language: _language,
  t,
}: {
  filter: SavedFilter
  isActive: boolean
  isConfirmingDelete: boolean
  onLoad: () => void
  onDelete: (e: React.MouseEvent) => void
  onTogglePin: (e: React.MouseEvent) => void
  language: string
  t: (key: string) => string
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
      {filter.isPinned && (
        <Pin size={12} style={{ color: tokens.colors.accent.warning, flexShrink: 0 }} />
      )}
      
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
          {t('usedTimes').replace('{n}', String(filter.useCount))}
        </Text>
      </Box>
      
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
          title={filter.isPinned ? t('unpinFilter') : t('pinFilter')}
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
            color: isConfirmingDelete ? 'var(--color-on-accent)' : tokens.colors.text.tertiary,
            cursor: 'pointer',
            opacity: isConfirmingDelete ? 1 : 0.6,
            transition: `all ${tokens.transition.base}`,
          }}
          onMouseEnter={(e) => e.currentTarget.style.opacity = '1'}
          onMouseLeave={(e) => {
            if (!isConfirmingDelete) e.currentTarget.style.opacity = '0.6'
          }}
          title={isConfirmingDelete ? t('confirmDeleteFilter') : t('delete')}
        >
          {isConfirmingDelete ? <Check size={14} /> : <Trash2 size={14} />}
        </button>
      </Box>
      
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
  t,
}: {
  filterName: string
  onFilterNameChange: (name: string) => void
  onSave: () => void
  onCancel: () => void
  t: (key: string) => string
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
        background: 'var(--color-backdrop, var(--color-overlay-dark))',
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
          boxShadow: tokens.shadow.xl,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[4] }}>
          {t('saveFilterConditions')}
        </Text>
        
        <input
          ref={inputRef}
          type="text"
          value={filterName}
          onChange={(e) => onFilterNameChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('enterFilterName')}
          aria-label={t('filterNameAriaLabel')}
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
            {t('cancel')}
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
              color: filterName.trim() ? 'var(--color-on-accent)' : tokens.colors.text.tertiary,
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: tokens.typography.fontWeight.bold,
              cursor: filterName.trim() ? 'pointer' : 'not-allowed',
              fontFamily: tokens.typography.fontFamily.sans.join(', '),
            }}
          >
            {t('save')}
          </button>
        </Box>
      </Box>
    </Box>
  )
}
