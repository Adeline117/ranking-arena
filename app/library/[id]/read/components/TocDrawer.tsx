'use client'

import { tokens } from '@/lib/design-tokens'
import type { TocItem, EpubTocEntry, ReadingTheme } from '../types'
import { THEME_PRESETS } from '../types'
import { IconClose } from './ReaderIcons'

interface TocDrawerProps {
  theme: ReadingTheme
  toc: TocItem[]
  epubToc: EpubTocEntry[]
  contentMode: 'pdf' | 'html' | 'epub' | 'none'
  currentPage: number
  bookmarks: number[]
  onClose: () => void
  onGoToPage: (page: number) => void
  onGoToEpubHref: (href: string) => void
  t: (key: string) => string
}

export function TocDrawer({
  theme, toc, epubToc, contentMode, currentPage, bookmarks,
  onClose, onGoToPage, onGoToEpubHref, t,
}: TocDrawerProps) {
  const themeColors = THEME_PRESETS[theme]

  function renderEpubTocItems(items: EpubTocEntry[], level = 0): React.ReactNode {
    return items.map((item: EpubTocEntry, i: number) => (
      <div key={i}>
        <button
          onClick={() => { onGoToEpubHref(item.href); onClose() }}
          style={{
            display: 'block', width: '100%', textAlign: 'left',
            padding: '10px 16px', paddingLeft: 16 + level * 20,
            background: 'none', border: 'none',
            color: themeColors.text,
            cursor: 'pointer', fontSize: 14, fontWeight: 500, lineHeight: 1.5,
            transition: 'background 0.15s',
          }}
          onMouseEnter={e => e.currentTarget.style.background = 'var(--overlay-hover)'}
          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
        >
          {item.label}
        </button>
        {item.subitems && item.subitems.length > 0 && renderEpubTocItems(item.subitems, level + 1)}
      </div>
    ))
  }

  function renderTocItems(items: TocItem[]): React.ReactNode {
    return items.map((item, i) => (
      <div key={i}>
        <button
          onClick={() => onGoToPage(item.pageIndex + 1)}
          style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            width: '100%', textAlign: 'left', padding: '10px 16px',
            paddingLeft: 16 + item.level * 20,
            background: currentPage === item.pageIndex + 1
              ? (theme === 'dark' ? 'var(--color-accent-primary-15)' : 'var(--color-accent-primary-08)')
              : 'none',
            border: 'none', color: themeColors.text,
            cursor: 'pointer', fontSize: 14, fontWeight: 500, lineHeight: 1.5, transition: 'background 0.15s',
          }}
          onMouseEnter={e => e.currentTarget.style.background = 'var(--glass-bg-light)'}
          onMouseLeave={e => e.currentTarget.style.background = currentPage === item.pageIndex + 1
            ? 'var(--color-accent-primary-15)' : 'transparent'}
        >
          <span style={{ flex: 1, marginRight: 12 }}>{item.title}</span>
          <span style={{ opacity: 0.5, fontSize: 11, flexShrink: 0 }}>{item.pageIndex + 1}</span>
        </button>
        {item.children && renderTocItems(item.children)}
      </div>
    ))
  }

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'var(--color-overlay-dark)', zIndex: 200 }} />
      <div style={{
        position: 'fixed', top: 0, left: 0, bottom: 0, width: 320, maxWidth: '85vw', zIndex: 201,
        background: themeColors.pageBg,
        boxShadow: '4px 0 24px var(--color-overlay-medium)', overflow: 'auto',
      }}>
        <div style={{
          position: 'sticky', top: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 16px', borderBottom: `1px solid ${theme === 'dark' ? 'var(--glass-border-light)' : 'var(--color-overlay-subtle)'}`,
          background: themeColors.pageBg,
        }}>
          <span style={{ fontSize: 16, fontWeight: 700, color: theme === 'dark' ? 'var(--color-on-accent)' : 'var(--color-text-primary)' }}>
            {t('readerContents')}
          </span>
          <button onClick={onClose} aria-label="Close table of contents" style={{ background: 'none', border: 'none', color: theme === 'dark' ? 'var(--glass-border-heavy)' : 'var(--color-backdrop-light)', cursor: 'pointer', padding: 4 }}>
            <IconClose />
          </button>
        </div>

        {/* Bookmarks section */}
        {bookmarks.length > 0 && (
          <div style={{ padding: '12px 16px', borderBottom: `1px solid ${theme === 'dark' ? 'var(--glass-border-light)' : 'var(--color-overlay-subtle)'}` }}>
            <p style={{ fontSize: 12, fontWeight: 600, color: theme === 'dark' ? 'var(--glass-bg-medium)' : 'var(--color-backdrop-light)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>
              {t('readerBookmarks')}
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {bookmarks.map(page => (
                <button key={page} onClick={() => onGoToPage(page)} style={{
                  padding: '4px 10px', borderRadius: tokens.radius.sm, fontSize: 12, fontWeight: 500,
                  background: currentPage === page ? 'var(--color-accent-primary)' : (theme === 'dark' ? 'var(--glass-bg-light)' : 'var(--color-overlay-subtle)'),
                  color: currentPage === page ? 'var(--color-on-accent)' : (theme === 'dark' ? 'var(--color-text-secondary)' : 'var(--color-backdrop)'),
                  border: 'none', cursor: 'pointer',
                }}>
                  {t('readerPagePrefix')}{page}{t('readerPageSuffix')}
                </button>
              ))}
            </div>
          </div>
        )}

        <div style={{ padding: '8px 0' }}>
          {contentMode === 'epub' ? renderEpubTocItems(epubToc) : renderTocItems(toc)}
        </div>
      </div>
    </>
  )
}
