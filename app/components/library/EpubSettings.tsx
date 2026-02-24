'use client'

import { tokens } from '@/lib/design-tokens'

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
  isZh: boolean
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
  isZh, show, onClose,
  panelBg, panelText, panelBorder, panelSubtle, accent,
  fontFamily, localLineHeight, localPageMargin,
  onLineHeightChange, onPageMarginChange,
}: EpubSettingsProps) {
  if (!show) return null

  return (
    <>
      <div onClick={onClose}
        role="presentation"
        style={{ position: 'fixed', inset: 0, background: 'var(--color-backdrop-light)', zIndex: 300 }} />
      <div role="dialog" aria-modal="true" aria-label={isZh ? '排版设置' : 'Typography'} style={{
        position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
        background: panelBg, color: panelText, borderRadius: tokens.radius['2xl'], padding: '28px 32px',
        width: 380, maxWidth: '90vw', zIndex: 301, boxShadow: 'var(--shadow-elevated)',
        border: `1px solid ${panelBorder}`,
      }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 20 }}>
          {isZh ? '排版设置' : 'Typography'}
        </h3>

        {/* Font Family */}
        <div style={{ marginBottom: 18 }}>
          <p style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, opacity: 0.5 }}>
            {isZh ? '字体' : 'Font Family'}
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {(Object.entries(FONT_FAMILY_MAP) as [FontFamily, string][]).map(([key, css]) => {
              const labels: Record<FontFamily, { zh: string; en: string }> = {
                sans: { zh: '黑体', en: 'Sans' },
                serif: { zh: '宋体', en: 'Serif' },
                mono: { zh: '等宽', en: 'Mono' },
                kai: { zh: '楷体', en: 'Kai' },
              }
              return (
                <button key={key} style={{
                  padding: '10px 8px', borderRadius: tokens.radius.md,
                  background: fontFamily === key ? accent : panelSubtle,
                  color: fontFamily === key ? 'var(--color-on-accent)' : panelText,
                  border: 'none', cursor: 'default', fontSize: 14,
                  fontFamily: css, fontWeight: 600, transition: 'all 0.15s',
                }}>
                  {isZh ? labels[key].zh : labels[key].en}
                </button>
              )
            })}
          </div>
        </div>

        {/* Line Height */}
        <div style={{ marginBottom: 18, borderTop: `1px solid ${panelBorder}`, paddingTop: 16 }}>
          <p style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, opacity: 0.5 }}>
            {isZh ? '行间距' : 'Line Height'}
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            {(['compact', 'normal', 'relaxed'] as LineHeight[]).map(lh => {
              const labels: Record<LineHeight, { zh: string; en: string }> = {
                compact: { zh: '紧凑', en: 'Compact' },
                normal: { zh: '标准', en: 'Normal' },
                relaxed: { zh: '宽松', en: 'Relaxed' },
              }
              return (
                <button key={lh} onClick={() => onLineHeightChange(lh)} style={{
                  flex: 1, padding: '8px 4px', borderRadius: tokens.radius.md,
                  background: localLineHeight === lh ? accent : panelSubtle,
                  color: localLineHeight === lh ? 'var(--color-on-accent)' : panelText,
                  border: 'none', cursor: 'pointer', fontSize: 12,
                  fontWeight: 600, transition: 'all 0.15s',
                }}>
                  {isZh ? labels[lh].zh : labels[lh].en}
                </button>
              )
            })}
          </div>
        </div>

        {/* Page Margin */}
        <div style={{ marginBottom: 18, borderTop: `1px solid ${panelBorder}`, paddingTop: 16 }}>
          <p style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, opacity: 0.5 }}>
            {isZh ? '页面边距' : 'Page Margins'}
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            {(['narrow', 'normal', 'wide'] as PageMargin[]).map(pm => {
              const labels: Record<PageMargin, { zh: string; en: string }> = {
                narrow: { zh: '窄', en: 'Narrow' },
                normal: { zh: '标准', en: 'Normal' },
                wide: { zh: '宽', en: 'Wide' },
              }
              return (
                <button key={pm} onClick={() => onPageMarginChange(pm)} style={{
                  flex: 1, padding: '8px 4px', borderRadius: tokens.radius.md,
                  background: localPageMargin === pm ? accent : panelSubtle,
                  color: localPageMargin === pm ? 'var(--color-on-accent)' : panelText,
                  border: 'none', cursor: 'pointer', fontSize: 12,
                  fontWeight: 600, transition: 'all 0.15s',
                }}>
                  {isZh ? labels[pm].zh : labels[pm].en}
                </button>
              )
            })}
          </div>
        </div>

        {/* Keyboard shortcuts reference */}
        <div style={{ borderTop: `1px solid ${panelBorder}`, paddingTop: 14 }}>
          <p style={{ fontSize: 11, opacity: 0.35, lineHeight: 1.7 }}>
            {isZh
              ? '快捷键: 方向键/空格 翻页 | S 搜索 | N 笔记 | I 统计 | T 排版 | Esc 关闭'
              : 'Keys: Arrows/Space nav | S search | N notes | I stats | T typography | Esc close'}
          </p>
        </div>
      </div>
    </>
  )
}
