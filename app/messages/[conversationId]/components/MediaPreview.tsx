'use client'

import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import { isPdfFile } from './types'

interface PreviewState {
  type: 'image' | 'video' | 'file'
  url: string
  fileName?: string
}

interface MediaPreviewProps {
  preview: PreviewState
  onClose: () => void
  t: (key: string) => string
}

export default function MediaPreview({ preview, onClose, t }: MediaPreviewProps) {
  return (
    <Box
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'var(--color-backdrop-heavy)',
        zIndex: tokens.zIndex.max, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
      }}
    >
      <button onClick={onClose} aria-label="Close preview" style={{
        position: 'absolute', top: 16, right: 16, width: 40, height: 40,
        borderRadius: '50%', border: 'none', background: 'var(--glass-bg-medium)',
        color: tokens.colors.white, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>

      {preview.type === 'image' ? (
        <Image src={preview.url} alt="Media preview" width={1200} height={900}
          onClick={(e) => e.stopPropagation()}
          style={{ maxWidth: '90vw', maxHeight: '90vh', objectFit: 'contain', borderRadius: tokens.radius.md }}
          unoptimized
        />
      ) : preview.type === 'video' ? (
        <video src={preview.url} controls autoPlay
          onClick={(e) => e.stopPropagation()}
          style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: tokens.radius.md }}
        />
      ) : preview.type === 'file' ? (
        isPdfFile(preview.url, preview.fileName) ? (
          <Box onClick={(e: React.MouseEvent) => e.stopPropagation()} style={{ width: '90vw', height: '90vh', borderRadius: tokens.radius.lg, overflow: 'hidden', background: tokens.colors.white }}>
            <iframe src={preview.url} style={{ width: '100%', height: '100%', border: 'none' }} title={preview.fileName || 'PDF Preview'} />
          </Box>
        ) : (
          <Box onClick={(e: React.MouseEvent) => e.stopPropagation()} style={{
            background: tokens.colors.bg.secondary, borderRadius: tokens.radius.xl, padding: '40px 48px',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, maxWidth: 400,
          }}>
            <Box style={{ width: 72, height: 72, borderRadius: tokens.radius.xl, background: tokens.colors.bg.tertiary, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.text.secondary} strokeWidth="1.5">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" />
              </svg>
            </Box>
            <Text size="base" weight="bold" style={{ color: tokens.colors.text.primary, textAlign: 'center', wordBreak: 'break-word' }}>
              {preview.fileName || t('file')}
            </Text>
            <Text size="sm" color="tertiary" style={{ textAlign: 'center' }}>
              {t('previewNotSupported') || '此文件类型不支持预览'}
            </Text>
            <a href={preview.url} target="_blank" rel="noopener noreferrer" style={{
              display: 'inline-flex', alignItems: 'center', gap: 8, padding: '12px 24px',
              background: `linear-gradient(135deg, ${tokens.colors.accent.brand} 0%, var(--color-brand-hover) 100%)`,
              color: tokens.colors.white, borderRadius: tokens.radius.lg, textDecoration: 'none', fontWeight: 700, fontSize: 14, marginTop: 8,
            }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              {t('download') || '下载文件'}
            </a>
          </Box>
        )
      ) : null}
    </Box>
  )
}
