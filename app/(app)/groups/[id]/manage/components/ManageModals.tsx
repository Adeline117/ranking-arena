'use client'

import { useEffect } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'

/** Shared ESC key + body scroll lock for simple modals */
function useModalA11y(onClose: () => void) {
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => { document.body.style.overflow = prev; document.removeEventListener('keydown', onKey) }
  }, [onClose])
}

interface MuteModalProps {
  targetUserId: string
  muteDuration: '3h' | '1d' | '7d' | 'permanent'
  setMuteDuration: (v: '3h' | '1d' | '7d' | 'permanent') => void
  muteReason: string
  setMuteReason: (v: string) => void
  onMute: (userId: string) => void
  onClose: () => void
  inputStyle: React.CSSProperties
  t: (key: string) => string
}

export function MuteModal({ targetUserId, muteDuration, setMuteDuration, muteReason, setMuteReason, onMute, onClose, inputStyle, t }: MuteModalProps) {
  useModalA11y(onClose)
  return (
    <Box style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'var(--color-backdrop)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: tokens.zIndex.modal }} onClick={onClose}>
      <Box style={{ background: tokens.colors.bg.primary, borderRadius: tokens.radius.xl, padding: tokens.spacing[6], width: '90%', maxWidth: 400, border: `1px solid ${tokens.colors.border.primary}` }} onClick={(e) => e.stopPropagation()}>
        <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[4] }}>{t('muteMember')}</Text>
        <Box style={{ marginBottom: tokens.spacing[4] }}>
          <Text size="sm" weight="bold" color="secondary" style={{ marginBottom: tokens.spacing[2] }}>{t('muteDuration')}</Text>
          <Box style={{ display: 'flex', gap: tokens.spacing[2], flexWrap: 'wrap' }}>
            {(['3h', '1d', '7d', 'permanent'] as const).map((d) => (
              <Button key={d} variant={muteDuration === d ? 'primary' : 'secondary'} size="sm" onClick={() => setMuteDuration(d)}>
                {d === '3h' ? t('duration3h') : d === '1d' ? t('duration1d') : d === '7d' ? t('duration7d') : t('durationPermanent')}
              </Button>
            ))}
          </Box>
        </Box>
        <Box style={{ marginBottom: tokens.spacing[4] }}>
          <Text size="sm" weight="bold" color="secondary" style={{ marginBottom: tokens.spacing[2] }}>{t('muteReasonOptional')}</Text>
          <textarea value={muteReason} onChange={(e) => setMuteReason(e.target.value)} placeholder={t('enterMuteReason')} style={{ ...inputStyle, minHeight: 80, resize: 'vertical' }} />
        </Box>
        <Box style={{ display: 'flex', gap: tokens.spacing[3], justifyContent: 'flex-end' }}>
          <Button variant="secondary" onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" onClick={() => onMute(targetUserId)}>{t('confirmMute')}</Button>
        </Box>
      </Box>
    </Box>
  )
}

interface NotifyModalProps {
  notifyTitle: string; setNotifyTitle: (v: string) => void
  notifyMessage: string; setNotifyMessage: (v: string) => void
  notifySending: boolean
  onNotify: () => void
  onClose: () => void
  inputStyle: React.CSSProperties
  t: (key: string) => string
}

export function NotifyModal({ notifyTitle, setNotifyTitle, notifyMessage, setNotifyMessage, notifySending, onNotify, onClose, inputStyle, t }: NotifyModalProps) {
  useModalA11y(onClose)
  return (
    <Box style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'var(--color-backdrop)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: tokens.zIndex.modal }} onClick={onClose}>
      <Box style={{ background: tokens.colors.bg.primary, borderRadius: tokens.radius.xl, padding: tokens.spacing[6], width: '90%', maxWidth: 450, border: `1px solid ${tokens.colors.border.primary}` }} onClick={(e) => e.stopPropagation()}>
        <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[4] }}>{t('notifyAllMembers')}</Text>
        <Box style={{ marginBottom: tokens.spacing[4] }}>
          <Text size="sm" weight="bold" color="secondary" style={{ marginBottom: tokens.spacing[2] }}>{t('notifyTitleOptional')}</Text>
          <input type="text" value={notifyTitle} onChange={(e) => setNotifyTitle(e.target.value)} placeholder={t('notifyTitlePlaceholder')} style={inputStyle} maxLength={50} />
        </Box>
        <Box style={{ marginBottom: tokens.spacing[4] }}>
          <Text size="sm" weight="bold" color="secondary" style={{ marginBottom: tokens.spacing[2] }}>{t('notifyContent')} *</Text>
          <textarea value={notifyMessage} onChange={(e) => setNotifyMessage(e.target.value)} placeholder={t('notifyContentPlaceholder')} style={{ ...inputStyle, minHeight: 120, resize: 'vertical' }} maxLength={500} />
          <Text size="xs" color="tertiary" style={{ marginTop: tokens.spacing[1], textAlign: 'right' }}>{notifyMessage.length}/500</Text>
        </Box>
        <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[4] }}>{t('notifyDeliveryNote')}</Text>
        <Box style={{ display: 'flex', gap: tokens.spacing[3], justifyContent: 'flex-end' }}>
          <Button variant="secondary" onClick={onClose} disabled={notifySending}>{t('cancel')}</Button>
          <Button variant="primary" onClick={onNotify} disabled={notifySending || !notifyMessage.trim()}>{notifySending ? t('sending') : t('sendNotification')}</Button>
        </Box>
      </Box>
    </Box>
  )
}
