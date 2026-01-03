'use client'

import React from 'react'

type ExportButtonProps = {
  data: any[]
  filename: string
  format?: 'csv' | 'json'
}

export default function ExportButton({ data, filename, format = 'csv' }: ExportButtonProps) {
  const handleExport = () => {
    if (format === 'csv') {
      const headers = Object.keys(data[0] || {})
      const csv = [
        headers.join(','),
        ...data.map(row => headers.map(header => {
          const value = row[header]
          return typeof value === 'string' && value.includes(',') ? `"${value}"` : value
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
        borderRadius: '8px',
        border: '1px solid rgba(255,255,255,0.1)',
        background: 'rgba(255,255,255,0.05)',
        color: '#eaeaea',
        fontWeight: 700,
        fontSize: '13px',
        cursor: 'pointer',
        transition: 'all 200ms ease',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'rgba(255,255,255,0.08)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'rgba(255,255,255,0.05)'
      }}
    >
      📥 导出 {format.toUpperCase()}
    </button>
  )
}

