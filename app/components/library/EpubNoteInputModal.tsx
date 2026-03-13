'use client'

import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { HIGHLIGHT_COLORS } from './EpubReaderUtils'

interface EpubNoteInputModalProps {
  pendingHighlight: { cfiRange: string; text: string }
  noteText: string
  highlightColor: string
  panelBg: string
  panelText: string
  panelBorder: string
  panelSubtle: string
  accent: string
  onNoteTextChange: (text: string) => void
  onHighlightColorChange: (color: string) => void
  onConfirm: () => void
  onCancel: () => void
}

export default function EpubNoteInputModal({
  pendingHighlight,
  noteText,
  highlightColor,
  panelBg,
  panelText,
  panelBorder,
  panelSubtle,
  accent,
  onNoteTextChange,
  onHighlightColorChange,
  onConfirm,
  onCancel,
}: EpubNoteInputModalProps) {
  const { t } = useLanguage()

  return (
    <>
      <div onClick={onCancel}
        role="presentation"
        style={{ position: 'fixed', inset: 0, background: 'var(--color-backdrop-light)', zIndex: 300 }} />
      <div role="dialog" aria-modal="true" aria-label={t('epubAddHighlight')} style={{
        position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
        background: panelBg, color: panelText, borderRadius: 16, padding: '24px 28px',
        width: 380, maxWidth: '90vw', zIndex: 301, boxShadow: '0 12px 40px var(--color-overlay-medium)',
        border: `1px solid ${panelBorder}`,
      }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 12 }}>
          {t('epubAddHighlight')}
        </h3>
        <p style={{
          fontSize: 13, lineHeight: 1.6, marginBottom: 12, padding: '8px 12px',
          background: panelSubtle, borderRadius: 8, borderLeft: `3px solid ${highlightColor}`,
          maxHeight: 80, overflow: 'auto',
        }}>
          {pendingHighlight.text.slice(0, 200)}{pendingHighlight.text.length > 200 ? '...' : ''}
        </p>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          {HIGHLIGHT_COLORS.map(c => (
            <button key={c} onClick={() => onHighlightColorChange(c)} style={{
              width: 28, height: 28, borderRadius: '50%', background: c, border: 'none',
              cursor: 'pointer',
              outline: highlightColor === c ? `2px solid ${panelText}` : 'none',
              outlineOffset: 2, transition: 'transform 0.15s',
              transform: highlightColor === c ? 'scale(1.15)' : 'scale(1)',
            }} />
          ))}
        </div>
        <textarea
          value={noteText}
          onChange={e => onNoteTextChange(e.target.value)}
          placeholder={t('epubAddNotePlaceholder')}
          style={{
            width: '100%', minHeight: 72, padding: '10px 12px', borderRadius: 8,
            border: `1px solid ${panelBorder}`, background: panelSubtle,
            color: panelText, fontSize: 13, resize: 'vertical', outline: 'none', fontFamily: 'inherit',
          }}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={{
            padding: '8px 18px', borderRadius: 8, border: `1px solid ${panelBorder}`,
            background: 'transparent', color: panelText, cursor: 'pointer', fontSize: 13,
          }}>
            {t('epubCancel')}
          </button>
          <button onClick={onConfirm} style={{
            padding: '8px 18px', borderRadius: 8, border: 'none',
            background: accent, color: 'var(--foreground)',
            cursor: 'pointer', fontSize: 13, fontWeight: 600,
          }}>
            {t('epubSave')}
          </button>
        </div>
      </div>
    </>
  )
}
