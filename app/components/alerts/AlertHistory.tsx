'use client'

import React, { useState } from 'react'
import { Box, Text, Button } from '../base'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

export interface HistoryItem {
  id: string
  alert_type: string
  triggered_at: string
  data: Record<string, unknown>
}

export interface AlertHistoryProps {
  history: HistoryItem[]
  alertTypeLabel: (type: string) => string
}

/**
 * Collapsible alert history list showing past triggered alerts.
 */
export function AlertHistory({ history, alertTypeLabel }: AlertHistoryProps) {
  const { language } = useLanguage()
  const { t } = useLanguage()
  const [showHistory, setShowHistory] = useState(false)

  if (history.length === 0) return null

  return (
    <Box>
      <Button
        onClick={() => setShowHistory(!showHistory)}
        style={{
          background: 'transparent',
          border: 'none',
          color: tokens.colors.accent.primary,
          cursor: 'pointer',
          fontSize: 13,
          padding: 0,
        }}
      >
        {t('alertHistory')} ({history.length})
      </Button>
      {showHistory && (
        <Box style={{ marginTop: 8, maxHeight: 200, overflow: 'auto' }}>
          {history.map(item => (
            <Box key={item.id} style={{
              padding: '6px 0',
              borderBottom: `1px solid ${tokens.colors.border.primary}`,
              fontSize: 12,
            }}>
              <Text style={{ color: tokens.colors.text.secondary }}>
                {new Date(item.triggered_at).toLocaleString(language === 'zh' ? 'zh-CN' : language === 'ja' ? 'ja-JP' : language === 'ko' ? 'ko-KR' : 'en-US')}
              </Text>
              <Text style={{ color: tokens.colors.text.primary, marginLeft: 8 }}>
                [{alertTypeLabel(item.alert_type)}] {(item.data as { message?: string })?.message || ''}
              </Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  )
}
