'use client'

import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import ModalOverlay from '@/app/components/ui/ModalOverlay'

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

export function MuteModal({
  targetUserId,
  muteDuration,
  setMuteDuration,
  muteReason,
  setMuteReason,
  onMute,
  onClose,
  inputStyle,
  t,
}: MuteModalProps) {
  return (
    <ModalOverlay open onClose={onClose} label={t('muteMember')} maxWidth={400}>
      <div style={{ padding: tokens.spacing[6] }}>
        <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[4] }}>
          {t('muteMember')}
        </Text>
        <Box style={{ marginBottom: tokens.spacing[4] }}>
          <Text
            size="sm"
            weight="bold"
            color="secondary"
            style={{ marginBottom: tokens.spacing[2] }}
          >
            {t('muteDuration')}
          </Text>
          <Box style={{ display: 'flex', gap: tokens.spacing[2], flexWrap: 'wrap' }}>
            {(['3h', '1d', '7d', 'permanent'] as const).map((d) => (
              <Button
                key={d}
                variant={muteDuration === d ? 'primary' : 'secondary'}
                size="sm"
                onClick={() => setMuteDuration(d)}
              >
                {d === '3h'
                  ? t('duration3h')
                  : d === '1d'
                    ? t('duration1d')
                    : d === '7d'
                      ? t('duration7d')
                      : t('durationPermanent')}
              </Button>
            ))}
          </Box>
        </Box>
        <Box style={{ marginBottom: tokens.spacing[4] }}>
          <Text
            size="sm"
            weight="bold"
            color="secondary"
            style={{ marginBottom: tokens.spacing[2] }}
          >
            {t('muteReasonOptional')}
          </Text>
          <textarea
            value={muteReason}
            onChange={(e) => setMuteReason(e.target.value)}
            placeholder={t('enterMuteReason')}
            style={{ ...inputStyle, minHeight: 80, resize: 'vertical' }}
          />
        </Box>
        <Box style={{ display: 'flex', gap: tokens.spacing[3], justifyContent: 'flex-end' }}>
          <Button variant="secondary" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button variant="primary" onClick={() => onMute(targetUserId)}>
            {t('confirmMute')}
          </Button>
        </Box>
      </div>
    </ModalOverlay>
  )
}

interface NotifyModalProps {
  notifyTitle: string
  setNotifyTitle: (v: string) => void
  notifyMessage: string
  setNotifyMessage: (v: string) => void
  notifySending: boolean
  onNotify: () => void
  onClose: () => void
  inputStyle: React.CSSProperties
  t: (key: string) => string
}

export function NotifyModal({
  notifyTitle,
  setNotifyTitle,
  notifyMessage,
  setNotifyMessage,
  notifySending,
  onNotify,
  onClose,
  inputStyle,
  t,
}: NotifyModalProps) {
  return (
    <ModalOverlay open onClose={onClose} label={t('notifyAllMembers')} maxWidth={450}>
      <div style={{ padding: tokens.spacing[6] }}>
        <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[4] }}>
          {t('notifyAllMembers')}
        </Text>
        <Box style={{ marginBottom: tokens.spacing[4] }}>
          <Text
            size="sm"
            weight="bold"
            color="secondary"
            style={{ marginBottom: tokens.spacing[2] }}
          >
            {t('notifyTitleOptional')}
          </Text>
          <input
            type="text"
            value={notifyTitle}
            onChange={(e) => setNotifyTitle(e.target.value)}
            placeholder={t('notifyTitlePlaceholder')}
            style={inputStyle}
            maxLength={50}
          />
        </Box>
        <Box style={{ marginBottom: tokens.spacing[4] }}>
          <Text
            size="sm"
            weight="bold"
            color="secondary"
            style={{ marginBottom: tokens.spacing[2] }}
          >
            {t('notifyContent')} *
          </Text>
          <textarea
            value={notifyMessage}
            onChange={(e) => setNotifyMessage(e.target.value)}
            placeholder={t('notifyContentPlaceholder')}
            style={{ ...inputStyle, minHeight: 120, resize: 'vertical' }}
            maxLength={500}
          />
          <Text
            size="xs"
            color="tertiary"
            style={{ marginTop: tokens.spacing[1], textAlign: 'right' }}
          >
            {notifyMessage.length}/500
          </Text>
        </Box>
        <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[4] }}>
          {t('notifyDeliveryNote')}
        </Text>
        <Box style={{ display: 'flex', gap: tokens.spacing[3], justifyContent: 'flex-end' }}>
          <Button variant="secondary" onClick={onClose} disabled={notifySending}>
            {t('cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={onNotify}
            disabled={notifySending || !notifyMessage.trim()}
          >
            {notifySending ? t('sending') : t('sendNotification')}
          </Button>
        </Box>
      </div>
    </ModalOverlay>
  )
}
