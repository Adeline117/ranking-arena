'use client'

import React from 'react'
import { useLanguage } from '../Providers/LanguageProvider'
import { tokens } from '@/lib/design-tokens'

type ExportButtonProps = {
  data: Record<string, unknown>[]
  filename: string
  format?: 'csv' | 'json'
}

export default function ExportButton({ data, filename, format = 'csv' }: ExportButtonProps) {
  const { t } = useLanguage()
  const handleExport = () => {
    if (!data || data.length === 0) return

    if (format === 'csv') {
      const firstRow = data[0]
      if (!firstRow) return
      const headers = Object.keys(firstRow)
      const csv = [
        headers.join(','),
        ...data.map(row => headers.map(header => {
          const value = row[header]
          if (value == null) return ''
          const str = String(value)
          // Escape CSV injection: prefix formula-like values with a single quote
          const safe = /^[=+\-@\t\r]/.test(str) ? `'${str}` : str
          // Quote if contains comma, quote, or newline
          return /[,"\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
        }).join(','))
      ].join('\n')

      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = `${filename}.csv`
      link.click()
    } else {
      const json = JSON.stringify(data, null, 2)
      const blob = new Blob([json], { type: 'application/json' })
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = `${filename}.json`
      link.click()
    }
  }

  return (
    <button
      onClick={handleExport}
      style={{
        padding: '8px 16px',
        borderRadius: tokens.radius.md,
        border: '1px solid var(--glass-border-light)',
        background: 'var(--overlay-hover)',
        color: tokens.colors.text.primary,
        fontWeight: 700,
        fontSize: tokens.typography.fontSize.sm,
        cursor: 'pointer',
        transition: 'all 200ms ease',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--glass-bg-light)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'var(--overlay-hover)'
      }}
    >
      {t('export')} {format.toUpperCase()}
    </button>
  )
}

