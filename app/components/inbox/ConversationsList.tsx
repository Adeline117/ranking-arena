'use client'

import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

export default function ConversationsList() {
  const { language } = useLanguage()

  return (
    <div style={{ padding: tokens.spacing[6], textAlign: 'center', color: tokens.colors.text.tertiary }}>
      <div style={{ fontSize: tokens.typography.fontSize.sm }}>
        {language === 'zh' ? '私信功能即将上线' : 'Messaging coming soon'}
      </div>
    </div>
  )
}
