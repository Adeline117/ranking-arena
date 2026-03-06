'use client'

import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

type ReadingTheme = 'white' | 'sepia' | 'dark' | 'green'
type FontSize = 'small' | 'medium' | 'large'
type FontFamily = 'sans' | 'serif' | 'mono' | 'kai'
type LineHeight = 'compact' | 'normal' | 'relaxed'
type PageMargin = 'narrow' | 'normal' | 'wide'

const FONT_FAMILY_MAP: Record<FontFamily, string> = {
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", sans-serif',
  serif: 'Georgia, "Noto Serif SC", "Source Han Serif SC", "Songti SC", "SimSun", serif',
  mono: '"SF Mono", "Fira Code", "Cascadia Code", Menlo, monospace',
  kai: '"STKaiti", "KaiTi", "楷体", serif',
}

interface EpubSettingsProps {
  show: boolean
  onClose: () => void
  // Theme-derived style vars
  panelBg: string
  panelText: string
  panelBorder: string
  panelSubtle: string
  accent: string
  // Current values (controlled by parent)
  fontFamily: FontFamily
  theme: ReadingTheme
  fontSize: FontSize
  localLineHeight: LineHeight
  localPageMargin: PageMargin
  onLineHeightChange: (lh: LineHeight) => void
  onPageMarginChange: (pm: PageMargin) => void
}

/** Typography settings panel (line height, page margin, font family display) */
export function EpubSettings({
  show, onClose,
  panelBg, panelText, panelBorder, panelSubtle, accent,
  fontFamily, localLineHeight, localPageMargin,
  onLineHeightChange, onPageMarginChange,
}: EpubSettingsProps) {
  const { t } = useLanguage()
  if (!show) return null

  return (
    <>
      <div onClick={onClose}
        role="presentation"
        style={{ position: 'fixed', inset: 0, background: 'var(--color-backdrop-light)', zIndex: 300 }} />
      <div role="dialog" aria-modal="true" aria-label={t('epubTypographyTitle')} style={{
        position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
        background: panelBg, color: panelText, borderRadius: tokens.radius['2xl'], padding: '28px 32px',
        width: 380, maxWidth: '90vw', zIndex: 301, boxShadow: 'var(--shadow-elevated)',
        border: `1px solid ${panelBorder}`,
      }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 20 }}>
          {t('epubTypographyTitle')}
        </h3>

        {/* Font Family */}
        <div style={{ marginBottom: 18 }}>
          <p style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, opacity: 0.5 }}>
            {t('epubFontFamily')}
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {(Object.entries(FONT_FAMILY_MAP) as [FontFamily, string][]).map(([key, css]) => {
              const labelKeys: Record<FontFamily, string> = {
                sans: 'epubFontSans',
                serif: 'epubFontSerif',
                mono: 'epubFontMono',
                kai: 'epubFontKai',
              }
              return (
                <button key={key} style={{
                  padding: '10px 8px', borderRadius: tokens.radius.md,
                  background: fontFamily === key ? accent : panelSubtle,
                  color: fontFamily === key ? 'var(--color-on-accent)' : panelText,
                  border: 'none', cursor: 'default', fontSize: 14,
                  fontFamily: css, fontWeight: 600, transition: 'all 0.15s',
                }}>
                  {t(labelKeys[key] as any)}
                </button>
              )
            })}
          </div>
        </div>

        {/* Line Height */}
        <div style={{ marginBottom: 18, borderTop: `1px solid ${panelBorder}`, paddingTop: 16 }}>
          <p style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, opacity: 0.5 }}>
            {t('epubLineHeight')}
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            {(['compact', 'normal', 'relaxed'] as LineHeight[]).map(lh => {
              const labelKeys: Record<LineHeight, string> = {
                compact: 'epubLineHeightCompact',
                normal: 'epubLineHeightNormal',
                relaxed: 'epubLineHeightRelaxed',
              }
              return (
                <button key={lh} onClick={() => onLineHeightChange(lh)} style={{
                  flex: 1, padding: '8px 4px', borderRadius: tokens.radius.md,
                  background: localLineHeight === lh ? accent : panelSubtle,
                  color: localLineHeight === lh ? 'var(--color-on-accent)' : panelText,
                  border: 'none', cursor: 'pointer', fontSize: 12,
                  fontWeight: 600, transition: 'all 0.15s',
                }}>
                  {t(labelKeys[lh] as any)}
                </button>
              )
            })}
          </div>
        </div>

        {/* Page Margin */}
        <div style={{ marginBottom: 18, borderTop: `1px solid ${panelBorder}`, paddingTop: 16 }}>
          <p style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, opacity: 0.5 }}>
            {t('epubPageMargin')}
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            {(['narrow', 'normal', 'wide'] as PageMargin[]).map(pm => {
              const labelKeys: Record<PageMargin, string> = {
                narrow: 'epubMarginNarrow',
                normal: 'epubMarginNormal',
                wide: 'epubMarginWide',
              }
              return (
                <button key={pm} onClick={() => onPageMarginChange(pm)} style={{
                  flex: 1, padding: '8px 4px', borderRadius: tokens.radius.md,
                  background: localPageMargin === pm ? accent : panelSubtle,
                  color: localPageMargin === pm ? 'var(--color-on-accent)' : panelText,
                  border: 'none', cursor: 'pointer', fontSize: 12,
                  fontWeight: 600, transition: 'all 0.15s',
                }}>
                  {t(labelKeys[pm] as any)}
                </button>
              )
            })}
          </div>
        </div>

        {/* Keyboard shortcuts reference */}
        <div style={{ borderTop: `1px solid ${panelBorder}`, paddingTop: 14 }}>
          <p style={{ fontSize: 11, opacity: 0.35, lineHeight: 1.7 }}>
            {t('epubShortcutsHelp')}
          </p>
        </div>
      </div>
    </>
  )
}
