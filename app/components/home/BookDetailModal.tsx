'use client'

import { useEffect, useState } from 'react'
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import StarRating from '@/app/components/ui/StarRating'
import type { LibraryItem } from '@/lib/types/library'

interface BookDetailModalProps {
  item: LibraryItem
  onClose: () => void
}

function MetaRow({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null
  return (
    <div style={{ display: 'flex', fontSize: 13, lineHeight: 1.8 }}>
      <span style={{ color: tokens.colors.text.secondary, minWidth: 80, flexShrink: 0 }}>{label}</span>
      <span style={{ color: tokens.colors.text.primary }}>{value}</span>
    </div>
  )
}

function langLabel(lang: string | null | undefined) {
  if (!lang) return null
  if (lang === 'zh') return '中文'
  if (lang === 'en') return 'English'
  return lang
}

export default function BookDetailModal({ item, onClose }: BookDetailModalProps) {
  const { language } = useLanguage()
  const isZh = language === 'zh'
  const { accessToken } = useAuthSession()
  const [userRating, setUserRating] = useState<number>(0)
  const [avgRating, setAvgRating] = useState(item.rating || 0)
  const [ratingCount, setRatingCount] = useState(item.rating_count || 0)
  const [submitting, setSubmitting] = useState(false)

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  // Prevent body scroll
  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [])

  async function handleRate(rating: number) {
    if (!accessToken || submitting) return
    setSubmitting(true)
    try {
      const res = await fetch(`/api/library/${item.id}/rate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ rating }),
      })
      const data = await res.json()
      if (data.success) {
        setUserRating(rating)
        setAvgRating(data.rating || avgRating)
        setRatingCount(data.rating_count || ratingCount)
      }
    } catch (e) {
      console.error('Rate failed:', e)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: tokens.colors.bg.primary,
          border: `1px solid ${tokens.colors.border.primary}`,
          borderRadius: 16, maxWidth: 640, width: '100%',
          maxHeight: '85vh', overflowY: 'auto',
          padding: 0,
        }}
      >
        {/* Header with cover */}
        <div style={{ display: 'flex', gap: 20, padding: '24px 24px 0' }}>
          {/* Cover */}
          <div style={{
            width: 140, height: 190, flexShrink: 0, borderRadius: 8, overflow: 'hidden',
            background: `linear-gradient(135deg, ${tokens.colors.accent.brand}22, ${tokens.colors.accent.brand}44)`,
            display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' as const,
          }}>
            {item.cover_url ? (
              <Image src={item.cover_url} alt={item.title || ''} fill style={{ objectFit: 'cover' }} unoptimized />
            ) : (
              <span style={{ fontSize: 48 }}>
                {item.category === 'book' ? 'BK' : item.category === 'whitepaper' ? 'WP' : item.category === 'paper' ? 'PP' : 'RS'}
              </span>
            )}
          </div>

          {/* Title + rating */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 style={{ fontSize: 20, fontWeight: 700, color: tokens.colors.text.primary, lineHeight: 1.3, marginBottom: 8 }}>
              {item.title}
            </h2>
            {item.author && (
              <p style={{ fontSize: 14, color: tokens.colors.text.secondary, marginBottom: 12 }}>
                {item.author}
              </p>
            )}

            {/* Rating display */}
            <div style={{ marginBottom: 12 }}>
              <StarRating
                rating={avgRating}
                ratingCount={ratingCount}
                size={22}
                readonly
              />
            </div>

            {/* User rating */}
            {accessToken && (
              <div>
                <p style={{ fontSize: 11, color: tokens.colors.text.secondary, marginBottom: 4 }}>
                  {isZh ? '我的评分' : 'My Rating'}
                </p>
                <StarRating
                  rating={avgRating}
                  userRating={userRating}
                  onRate={handleRate}
                  size={18}
                  showCount={false}
                />
              </div>
            )}
          </div>

          {/* Close button */}
          <button
            onClick={onClose}
            style={{
              position: 'absolute', top: 16, right: 16,
              background: 'none', border: 'none', color: tokens.colors.text.secondary,
              fontSize: 20, cursor: 'pointer', padding: 4,
            }}
          >
            X
          </button>
        </div>

        {/* Metadata block — 豆瓣风格 */}
        <div style={{
          margin: '20px 24px', padding: 16,
          background: tokens.colors.bg.secondary,
          borderRadius: 10, border: `1px solid ${tokens.colors.border.primary}`,
        }}>
          <h4 style={{ fontSize: 13, fontWeight: 700, color: tokens.colors.text.primary, marginBottom: 8 }}>
            {isZh ? '图书信息' : 'Book Info'}
          </h4>
          <MetaRow label={isZh ? '作者' : 'Author'} value={item.author} />
          <MetaRow label={isZh ? '出版社' : 'Publisher'} value={item.publisher} />
          <MetaRow label={isZh ? '出版日期' : 'Published'} value={item.publish_date} />
          <MetaRow label="ISBN" value={item.isbn} />
          <MetaRow label={isZh ? '页数' : 'Pages'} value={item.page_count ? String(item.page_count) : null} />
          <MetaRow label={isZh ? '语言' : 'Language'} value={langLabel(item.language)} />
          <MetaRow label={isZh ? '分类' : 'Category'} value={item.category} />
          {item.tags && item.tags.length > 0 && (
            <div style={{ display: 'flex', fontSize: 13, lineHeight: 1.8 }}>
              <span style={{ color: tokens.colors.text.secondary, minWidth: 80, flexShrink: 0 }}>
                {isZh ? '标签' : 'Tags'}
              </span>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {item.tags.map(tag => (
                  <span key={tag} style={{
                    fontSize: 11, padding: '1px 8px', borderRadius: 8,
                    background: tokens.colors.accent.brand + '18', color: tokens.colors.accent.brand,
                  }}>
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Description */}
        {item.description && (
          <div style={{ padding: '0 24px 20px' }}>
            <h4 style={{ fontSize: 13, fontWeight: 700, color: tokens.colors.text.primary, marginBottom: 8 }}>
              {isZh ? '简介' : 'Description'}
            </h4>
            <p style={{ fontSize: 13, color: tokens.colors.text.secondary, lineHeight: 1.7 }}>
              {item.description}
            </p>
          </div>
        )}

        {/* Action buttons */}
        <div style={{
          display: 'flex', gap: 10, padding: '0 24px 24px',
        }}>
          {item.pdf_url && (
            <a
              href={item.pdf_url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                padding: '8px 20px', borderRadius: 8,
                background: tokens.colors.accent.brand, color: '#fff',
                textDecoration: 'none', fontWeight: 600, fontSize: 13,
              }}
            >
              {isZh ? '阅读 PDF' : 'Read PDF'} ↗
            </a>
          )}
          {item.source_url && (
            <a
              href={item.source_url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                padding: '8px 20px', borderRadius: 8,
                border: `1px solid ${tokens.colors.border.primary}`,
                color: tokens.colors.text.primary,
                textDecoration: 'none', fontWeight: 500, fontSize: 13,
              }}
            >
              {isZh ? '来源' : 'Source'} ↗
            </a>
          )}
          {item.buy_url && (
            <a
              href={item.buy_url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                padding: '8px 20px', borderRadius: 8,
                border: `1px solid ${tokens.colors.border.primary}`,
                color: tokens.colors.text.primary,
                textDecoration: 'none', fontWeight: 500, fontSize: 13,
              }}
            >
              {isZh ? '购买' : 'Buy'} ↗
            </a>
          )}
        </div>
      </div>
    </div>
  )
}
