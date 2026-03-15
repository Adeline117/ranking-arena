'use client'

import { useLanguage } from '../Providers/LanguageProvider'

const MESSAGES: Record<string, string> = {
  en: 'Arena is in closed beta — data is being updated and some features are under development.',
  zh: 'Arena 处于内测阶段，数据正在更新中，部分功能仍在开发。',
  ko: 'Arena는 비공개 베타 단계입니다. 데이터가 업데이트 중이며 일부 기능은 개발 중입니다.',
  ja: 'Arena はクローズドベータ版です。データ更新中で、一部機能は開発中です。',
}

export default function BetaBanner() {
  const { language } = useLanguage()

  if (process.env.NEXT_PUBLIC_SHOW_BETA_BANNER === 'false') return null

  const message = MESSAGES[language] || MESSAGES.en

  return (
    <div
      style={{
        background: 'linear-gradient(90deg, #f59e0b, #ef4444)',
        color: 'white',
        textAlign: 'center',
        padding: '8px 16px',
        fontSize: '14px',
        fontWeight: 600,
        position: 'sticky',
        top: 0,
        zIndex: 9999,
      }}
    >
      🚧 {message}
    </div>
  )
}
