'use client'

import { useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { useToast } from './Toast'
import { getCsrfHeaders } from '@/lib/api/client'
import { useLanguage } from '../Providers/LanguageProvider'

export type ReportContentType = 'post' | 'comment' | 'message' | 'user'
export type ReportReason = 'spam' | 'harassment' | 'inappropriate' | 'misinformation' | 'fraud' | 'other'

interface ReportModalProps {
  isOpen: boolean
  onClose: () => void
  contentType: ReportContentType
  contentId: string
  accessToken: string
  /** Optional: display name of what's being reported */
  targetName?: string
}

const REASON_OPTIONS: { value: ReportReason; labelZh: string; labelEn: string }[] = [
  { value: 'spam', labelZh: '垃圾信息/广告', labelEn: 'Spam/Advertising' },
  { value: 'harassment', labelZh: '骚扰/辱骂', labelEn: 'Harassment/Abuse' },
  { value: 'inappropriate', labelZh: '不当内容', labelEn: 'Inappropriate Content' },
  { value: 'misinformation', labelZh: '虚假信息', labelEn: 'Misinformation' },
  { value: 'fraud', labelZh: '诈骗/欺诈', labelEn: 'Fraud/Scam' },
  { value: 'other', labelZh: '其他', labelEn: 'Other' },
]

const CONTENT_TYPE_LABELS: Record<ReportContentType, { zh: string; en: string }> = {
  post: { zh: '帖子', en: 'Post' },
  comment: { zh: '评论', en: 'Comment' },
  message: { zh: '私信/对话', en: 'Message/Conversation' },
  user: { zh: '用户', en: 'User' },
}

export default function ReportModal({
  isOpen,
  onClose,
  contentType,
  contentId,
  accessToken,
  targetName,
}: ReportModalProps) {
  const { language } = useLanguage()
  const { showToast } = useToast()
  const [reason, setReason] = useState<ReportReason | null>(null)
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const isZh = language === 'zh'
  const contentTypeLabel = isZh
    ? CONTENT_TYPE_LABELS[contentType].zh
    : CONTENT_TYPE_LABELS[contentType].en

  const handleSubmit = async () => {
    if (!reason) {
      showToast(isZh ? '请选择举报原因' : 'Please select a reason', 'warning')
      return
    }

    if (reason === 'other' && !description.trim()) {
      showToast(isZh ? '选择"其他"时请填写具体原因' : 'Please describe the reason when selecting "Other"', 'warning')
      return
    }

    setSubmitting(true)
    try {
      const res = await fetch('/api/reports', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({
          content_type: contentType,
          content_id: contentId,
          reason,
          description: description.trim() || null,
        }),
      })

      const data = await res.json()

      if (!res.ok) {
        showToast(data.error || (isZh ? '举报失败' : 'Report failed'), 'error')
        return
      }

      showToast(isZh ? '举报已提交，我们会尽快处理' : 'Report submitted, we will review it soon', 'success')
      onClose()
      // Reset form
      setReason(null)
      setDescription('')
    } catch (error) {
      console.error('Report error:', error)
      showToast(isZh ? '网络错误，请重试' : 'Network error, please try again', 'error')
    } finally {
      setSubmitting(false)
    }
  }

  if (!isOpen) return null

  return (
    <>
      {/* Overlay */}
      <Box
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0, 0, 0, 0.6)',
          zIndex: 2000,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: tokens.spacing[4],
        }}
      >
        {/* Modal */}
        <Box
          onClick={(e) => e.stopPropagation()}
          style={{
            width: '100%',
            maxWidth: 420,
            background: tokens.colors.bg.primary,
            borderRadius: tokens.radius.xl,
            boxShadow: '0 20px 40px rgba(0, 0, 0, 0.4)',
            overflow: 'hidden',
          }}
        >
          {/* Header */}
          <Box
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: `${tokens.spacing[4]} ${tokens.spacing[5]}`,
              borderBottom: `1px solid ${tokens.colors.border.primary}`,
            }}
          >
            <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
              <Box style={{ color: '#f44336' }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
                  <line x1="4" y1="22" x2="4" y2="15" />
                </svg>
              </Box>
              <Text size="lg" weight="bold">
                {isZh ? `举报${contentTypeLabel}` : `Report ${contentTypeLabel}`}
              </Text>
            </Box>
            <button
              onClick={onClose}
              style={{
                width: 32,
                height: 32,
                borderRadius: tokens.radius.full,
                border: 'none',
                background: tokens.colors.bg.secondary,
                color: tokens.colors.text.secondary,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </Box>

          {/* Content */}
          <Box style={{ padding: tokens.spacing[5] }}>
            {/* Target info */}
            {targetName && (
              <Box
                style={{
                  padding: tokens.spacing[3],
                  background: tokens.colors.bg.secondary,
                  borderRadius: tokens.radius.md,
                  marginBottom: tokens.spacing[4],
                }}
              >
                <Text size="sm" color="secondary">
                  {isZh ? '举报对象: ' : 'Reporting: '}
                  <span style={{ color: tokens.colors.text.primary, fontWeight: 600 }}>{targetName}</span>
                </Text>
              </Box>
            )}

            {/* Reason selection */}
            <Box style={{ marginBottom: tokens.spacing[4] }}>
              <Text size="sm" weight="semibold" style={{ marginBottom: tokens.spacing[2] }}>
                {isZh ? '举报原因 *' : 'Reason *'}
              </Text>
              <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
                {REASON_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    onClick={() => setReason(option.value)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: tokens.spacing[3],
                      padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                      background: reason === option.value
                        ? 'rgba(244, 67, 54, 0.1)'
                        : tokens.colors.bg.secondary,
                      border: reason === option.value
                        ? '1px solid rgba(244, 67, 54, 0.5)'
                        : `1px solid ${tokens.colors.border.primary}`,
                      borderRadius: tokens.radius.md,
                      color: tokens.colors.text.primary,
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                      textAlign: 'left',
                    }}
                  >
                    <Box
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: '50%',
                        border: reason === option.value
                          ? '2px solid #f44336'
                          : `2px solid ${tokens.colors.border.secondary}`,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                      }}
                    >
                      {reason === option.value && (
                        <Box
                          style={{
                            width: 10,
                            height: 10,
                            borderRadius: '50%',
                            background: '#f44336',
                          }}
                        />
                      )}
                    </Box>
                    <Text size="sm">{isZh ? option.labelZh : option.labelEn}</Text>
                  </button>
                ))}
              </Box>
            </Box>

            {/* Description */}
            <Box style={{ marginBottom: tokens.spacing[4] }}>
              <Text size="sm" weight="semibold" style={{ marginBottom: tokens.spacing[2] }}>
                {isZh ? '详细说明' : 'Details'}
                {reason === 'other' && <span style={{ color: '#f44336' }}> *</span>}
              </Text>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={isZh ? '请描述具体情况，帮助我们更好地处理...' : 'Please describe the situation...'}
                maxLength={1000}
                rows={4}
                style={{
                  width: '100%',
                  padding: tokens.spacing[3],
                  background: tokens.colors.bg.secondary,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  borderRadius: tokens.radius.md,
                  color: tokens.colors.text.primary,
                  fontSize: tokens.typography.fontSize.sm,
                  fontFamily: tokens.typography.fontFamily.sans.join(', '),
                  resize: 'vertical',
                  outline: 'none',
                  transition: 'border-color 0.2s',
                }}
                onFocus={(e) => {
                  e.target.style.borderColor = '#f44336'
                }}
                onBlur={(e) => {
                  e.target.style.borderColor = tokens.colors.border.primary
                }}
              />
              <Text size="xs" color="tertiary" style={{ marginTop: 4, textAlign: 'right' }}>
                {description.length}/1000
              </Text>
            </Box>

            {/* Notice */}
            <Box
              style={{
                padding: tokens.spacing[3],
                background: 'rgba(255, 152, 0, 0.1)',
                borderRadius: tokens.radius.md,
                marginBottom: tokens.spacing[4],
              }}
            >
              <Text size="xs" color="secondary" style={{ lineHeight: 1.5 }}>
                {isZh
                  ? '举报将由管理员审核。恶意举报可能导致账号受限。'
                  : 'Reports will be reviewed by admins. Malicious reports may result in account restrictions.'}
              </Text>
            </Box>

            {/* Actions */}
            <Box style={{ display: 'flex', gap: tokens.spacing[3] }}>
              <button
                onClick={onClose}
                style={{
                  flex: 1,
                  padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                  background: tokens.colors.bg.secondary,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  borderRadius: tokens.radius.md,
                  color: tokens.colors.text.secondary,
                  fontSize: tokens.typography.fontSize.sm,
                  fontWeight: 600,
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                }}
              >
                {isZh ? '取消' : 'Cancel'}
              </button>
              <button
                onClick={handleSubmit}
                disabled={submitting || !reason}
                style={{
                  flex: 1,
                  padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                  background: reason ? '#f44336' : tokens.colors.bg.tertiary,
                  border: 'none',
                  borderRadius: tokens.radius.md,
                  color: reason ? '#fff' : tokens.colors.text.tertiary,
                  fontSize: tokens.typography.fontSize.sm,
                  fontWeight: 600,
                  cursor: submitting || !reason ? 'not-allowed' : 'pointer',
                  opacity: submitting ? 0.6 : 1,
                  transition: 'all 0.2s',
                }}
              >
                {submitting
                  ? (isZh ? '提交中...' : 'Submitting...')
                  : (isZh ? '提交举报' : 'Submit Report')}
              </button>
            </Box>
          </Box>
        </Box>
      </Box>
    </>
  )
}
