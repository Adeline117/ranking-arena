'use client'

import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

type ReadingTheme = 'white' | 'sepia' | 'dark' | 'green'
type FontSize = 'small' | 'medium' | 'large'
type FontFamily = 'sans' | 'serif' | 'mono' | 'kai'
type ContentMode = 'pdf' | 'html' | 'epub' | 'none'

const THEME_PRESETS: Record<ReadingTheme, {
  dot: string;
  settingsLabel: string; settingsOption: string; settingsOptionInactive: string;
  settingsControlBg: string; settingsHint: string;
}> = {
  white:  { dot: 'var(--color-on-accent)',
    settingsLabel: 'var(--color-text-secondary)', settingsOption: 'var(--color-text-secondary)', settingsOptionInactive: 'var(--color-text-primary)',
    settingsControlBg: 'var(--color-overlay-subtle)', settingsHint: 'var(--color-text-tertiary)' },
  sepia:  { dot: 'var(--color-bg-secondary)',
    settingsLabel: 'var(--color-text-secondary)', settingsOption: 'var(--color-text-tertiary)', settingsOptionInactive: 'var(--color-text-primary)',
    settingsControlBg: 'var(--glass-bg-light)', settingsHint: 'var(--color-overlay-light)' },
  dark:   { dot: 'var(--color-bg-secondary)',
    settingsLabel: 'var(--color-text-secondary)', settingsOption: 'var(--color-text-tertiary)', settingsOptionInactive: 'var(--color-text-primary)',
    settingsControlBg: 'var(--glass-bg-light)', settingsHint: 'var(--color-text-quaternary)' },
  green:  { dot: 'var(--color-accent-success-20)',
    settingsLabel: 'var(--color-text-secondary)', settingsOption: 'var(--color-text-tertiary)', settingsOptionInactive: 'var(--color-text-primary)',
    settingsControlBg: 'var(--glass-bg-light)', settingsHint: 'var(--color-text-quaternary)' },
}

const FONT_FAMILIES: Record<FontFamily, { css: string }> = {
  sans:  { css: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", sans-serif' },
  serif: { css: 'Georgia, "Noto Serif SC", "Source Han Serif SC", "Songti SC", "SimSun", serif' },
  mono:  { css: '"SF Mono", "Fira Code", "Cascadia Code", Menlo, monospace' },
  kai:   { css: '"STKaiti", "KaiTi", "楷体", serif' },
}

interface ReaderSettingsProps {
  theme: ReadingTheme
  fontSize: FontSize
  fontFamily: FontFamily
  lineHeight: 'compact' | 'normal' | 'relaxed'
  contentMode: ContentMode
  onThemeChange: (theme: ReadingTheme) => void
  onFontSizeChange: (size: FontSize) => void
  onFontFamilyChange: (family: FontFamily) => void
  onLineHeightChange: (lh: 'compact' | 'normal' | 'relaxed') => void
  onClose: () => void
}

export default function ReaderSettings({
  theme, fontSize, fontFamily, lineHeight, contentMode,
  onThemeChange, onFontSizeChange, onFontFamilyChange, onLineHeightChange, onClose,
}: ReaderSettingsProps) {
  const { t } = useLanguage()
  const themeColors = THEME_PRESETS[theme]
  const pageBg = theme === 'dark' ? 'var(--color-bg-secondary)' : theme === 'sepia' ? 'var(--color-bg-secondary)' : theme === 'green' ? 'var(--color-accent-success-20)' : 'var(--color-on-accent)'

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 200 }} />
      <div style={{
        position: 'fixed', top: 56, right: 12, zIndex: 201,
        background: pageBg,
        borderRadius: tokens.radius.xl, boxShadow: '0 8px 32px var(--color-overlay-medium)',
        padding: '20px 24px', width: 280,
        border: `1px solid ${theme === 'dark' ? 'var(--glass-border-light)' : 'var(--color-overlay-subtle)'}`,
      }}>
        {/* Theme */}
        <p style={{ fontSize: tokens.typography.fontSize.sm, fontWeight: 600, marginBottom: 12, color: themeColors.settingsLabel }}>
          {t('readerTheme')}
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginBottom: 18 }}>
          {(Object.keys(THEME_PRESETS) as ReadingTheme[]).map(themeKey => (
            <button key={themeKey} onClick={() => onThemeChange(themeKey)} style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
              background: 'none', border: 'none', cursor: 'pointer', padding: 4,
            }}>
              <div style={{
                width: 36, height: 36, borderRadius: '50%',
                background: THEME_PRESETS[themeKey].dot,
                border: theme === themeKey ? '3px solid var(--color-accent-primary)' : `2px solid ${theme === 'dark' ? 'var(--glass-border-medium)' : 'var(--color-overlay-light)'}`,
                transition: 'border 0.2s',
              }} />
              <span style={{
                fontSize: 11,
                color: theme === themeKey ? 'var(--color-accent-primary)' : themeColors.settingsOption,
                fontWeight: theme === themeKey ? 600 : 400,
              }}>
                {({ white: t('readerThemeWhite'), sepia: t('readerThemeSepia'), dark: t('readerThemeDark'), green: t('readerThemeGreen') }[themeKey])}
              </span>
            </button>
          ))}
        </div>

        {/* Font Size */}
        <div style={{ borderTop: `1px solid ${theme === 'dark' ? 'var(--glass-border-light)' : 'var(--color-overlay-subtle)'}`, paddingTop: 14, marginBottom: 14 }}>
          <p style={{ fontSize: 13, fontWeight: 600, marginBottom: 10, color: themeColors.settingsLabel }}>
            {t('readerFontSize')}
          </p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
            {(['small', 'medium', 'large'] as FontSize[]).map(s => (
              <button key={s} onClick={() => onFontSizeChange(s)} style={{
                flex: 1, padding: '8px 4px', borderRadius: 10,
                background: fontSize === s ? 'var(--color-accent-primary)' : themeColors.settingsControlBg,
                color: fontSize === s ? 'var(--color-on-accent)' : themeColors.settingsOptionInactive,
                border: 'none', cursor: 'pointer', fontSize: s === 'small' ? 13 : s === 'large' ? 18 : 15,
                fontWeight: 600, transition: 'all 0.15s',
              }}>
                {({ small: t('readerFontSmall'), medium: t('readerFontMedium'), large: t('readerFontLarge') }[s])}
              </button>
            ))}
          </div>
        </div>

        {/* Line Height (HTML mode) */}
        {contentMode === 'html' && (
          <div style={{ borderTop: `1px solid ${theme === 'dark' ? 'var(--glass-border-light)' : 'var(--color-overlay-subtle)'}`, paddingTop: 14, marginBottom: 14 }}>
            <p style={{ fontSize: 13, fontWeight: 600, marginBottom: 10, color: themeColors.settingsLabel }}>
              {t('readerLineHeight')}
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
              {(['compact', 'normal', 'relaxed'] as const).map(lh => (
                <button key={lh} onClick={() => onLineHeightChange(lh)} style={{
                  flex: 1, padding: '8px 4px', borderRadius: 10,
                  background: lineHeight === lh ? 'var(--color-accent-primary)' : themeColors.settingsControlBg,
                  color: lineHeight === lh ? 'var(--color-on-accent)' : themeColors.settingsOptionInactive,
                  border: 'none', cursor: 'pointer', fontSize: 13,
                  fontWeight: 600, transition: 'all 0.15s',
                }}>
                  {({ compact: t('readerLineHeightCompact'), normal: t('readerLineHeightNormal'), relaxed: t('readerLineHeightRelaxed') }[lh])}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Font Family (HTML/ePub mode) */}
        {(contentMode === 'html' || contentMode === 'epub') && (
          <div style={{ borderTop: `1px solid ${theme === 'dark' ? 'var(--glass-border-light)' : 'var(--color-overlay-subtle)'}`, paddingTop: 14, marginBottom: 14 }}>
            <p style={{ fontSize: 13, fontWeight: 600, marginBottom: 10, color: themeColors.settingsLabel }}>
              {t('readerFontFamily')}
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
              {(Object.keys(FONT_FAMILIES) as FontFamily[]).map(f => {
                const labelKeys: Record<FontFamily, string> = {
                  sans: 'readerFontSans', serif: 'readerFontSerif', mono: 'readerFontMono', kai: 'readerFontKai',
                }
                return (
                  <button key={f} onClick={() => onFontFamilyChange(f)} style={{
                    flex: 1, padding: '8px 4px', borderRadius: 10,
                    background: fontFamily === f ? 'var(--color-accent-primary)' : themeColors.settingsControlBg,
                    color: fontFamily === f ? 'var(--color-on-accent)' : themeColors.settingsOptionInactive,
                    border: 'none', cursor: 'pointer', fontSize: 14,
                    fontFamily: FONT_FAMILIES[f].css,
                    fontWeight: 600, transition: 'all 0.15s',
                  }}>
                    {t(labelKeys[f])}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        <div style={{
          paddingTop: 14,
          borderTop: `1px solid ${theme === 'dark' ? 'var(--glass-border-light)' : 'var(--color-overlay-subtle)'}`,
        }}>
          <p style={{ fontSize: 11, color: themeColors.settingsHint, textAlign: 'center', lineHeight: 1.6 }}>
            {t('readerShortcutsHint')}
          </p>
        </div>
      </div>
    </>
  )
}
