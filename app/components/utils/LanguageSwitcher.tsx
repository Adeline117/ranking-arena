'use client'

import { useLanguage } from './LanguageProvider'

export default function LanguageSwitcher() {
  const { language: lang, setLanguage } = useLanguage()

  const handleChange = (newLang: 'zh' | 'en') => {
    setLanguage(newLang)
  }

  return (
    <div
      role="radiogroup"
      aria-label="选择语言"
      style={{
        display: 'flex',
        gap: '4px',
        background: 'rgba(255,255,255,0.05)',
        borderRadius: '8px',
        padding: '2px',
      }}
    >
      <button
        onClick={() => handleChange('zh')}
        role="radio"
        aria-checked={lang === 'zh'}
        aria-label="切换到中文"
        style={{
          padding: '4px 10px',
          borderRadius: '6px',
          border: 'none',
          background: lang === 'zh' ? '#8b6fa8' : 'transparent',
          color: lang === 'zh' ? '#fff' : '#9a9a9a',
          fontWeight: lang === 'zh' ? 900 : 700,
          fontSize: '12px',
          cursor: 'pointer',
          transition: 'all 150ms ease',
        }}
      >
        中文
      </button>
      <button
        onClick={() => handleChange('en')}
        role="radio"
        aria-checked={lang === 'en'}
        aria-label="Switch to English"
        style={{
          padding: '4px 10px',
          borderRadius: '6px',
          border: 'none',
          background: lang === 'en' ? '#8b6fa8' : 'transparent',
          color: lang === 'en' ? '#fff' : '#9a9a9a',
          fontWeight: lang === 'en' ? 900 : 700,
          fontSize: '12px',
          cursor: 'pointer',
          transition: 'all 150ms ease',
        }}
      >
        EN
      </button>
    </div>
  )
}
