'use client'

import { useLanguage } from '@/app/components/Providers/LanguageProvider'

interface EpubLoadingIndicatorProps {
  panelText: string
  accent: string
}

export default function EpubLoadingIndicator({ panelText, accent }: EpubLoadingIndicatorProps) {
  const { t } = useLanguage()

  return (
    <div style={{
      position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12,
    }}>
      <div style={{
        width: 32, height: 32, border: '3px solid var(--color-overlay-medium)',
        borderTopColor: accent, borderRadius: '50%',
        animation: 'epubSpin 0.8s linear infinite',
      }} />
      <span style={{ fontSize: 13, color: panelText, opacity: 0.5 }}>
        {t('epubLoading')}
      </span>
    </div>
  )
}
