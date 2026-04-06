'use client'

import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { ToggleSwitch } from '@/app/(app)/settings/components/shared'
import { logger } from '@/lib/logger'

type PushStatus = 'loading' | 'unsupported' | 'denied' | 'subscribed' | 'unsubscribed'

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  const outputArray = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i)
  }
  return outputArray
}

interface PushNotificationToggleProps {
  onToast?: (message: string, type: 'success' | 'error') => void
}

export function PushNotificationToggle({ onToast }: PushNotificationToggleProps) {
  const { t } = useLanguage()
  const [status, setStatus] = useState<PushStatus>('loading')
  const [busy, setBusy] = useState(false)

   
  const toast = useMemo(() => onToast || ((msg: string) => logger.warn(msg)), [onToast])

  // Check current status on mount
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window)) {
      setStatus('unsupported')
      return
    }
    if (Notification.permission === 'denied') {
      setStatus('denied')
      return
    }
    navigator.serviceWorker.ready.then(async (reg) => {
      const sub = await reg.pushManager.getSubscription()
      setStatus(sub ? 'subscribed' : 'unsubscribed')
    }).catch(() => setStatus('unsupported'))
  }, [])

  const subscribe = useCallback(async () => {
    setBusy(true)
    try {
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        setStatus('denied')
        toast(t('allowNotificationPermission'), 'error')
        return
      }

      const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
      if (!vapidKey) {
        toast(t('pushNotificationError'), 'error')
        return
      }

      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey) as BufferSource,
      })

      const json = sub.toJSON()
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: sub.endpoint,
          provider: 'web',
          platform: 'web',
          endpoint: sub.endpoint,
          p256dh: json.keys?.p256dh,
          auth: json.keys?.auth,
        }),
      })

      setStatus('subscribed')
      toast(t('pushNotificationsEnabled'), 'success')
    } catch (err) {
      logger.error('[PushToggle] subscribe error:', err)
      toast(t('pushNotificationError'), 'error')
    } finally {
      setBusy(false)
    }
  }, [t, toast])

  const unsubscribe = useCallback(async () => {
    setBusy(true)
    try {
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.getSubscription()
      if (sub) {
        await fetch(`/api/push/subscribe?token=${encodeURIComponent(sub.endpoint)}`, {
          method: 'DELETE',
        })
        await sub.unsubscribe()
      }
      setStatus('unsubscribed')
    } catch (err) {
      logger.error('[PushToggle] unsubscribe error:', err)
      toast(t('pushNotificationError'), 'error')
    } finally {
      setBusy(false)
    }
  }, [t, toast])

  const handleToggle = useCallback(async (enabled: boolean) => {
    if (enabled) {
      await subscribe()
    } else {
      await unsubscribe()
    }
  }, [subscribe, unsubscribe])

  if (status === 'unsupported') return null

  const isOn = status === 'subscribed'
  const isDenied = status === 'denied'
  const isLoading = status === 'loading' || busy

  return (
    <Box
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: `${tokens.spacing[3]} ${tokens.spacing[3]}`,
        borderRadius: tokens.radius.md,
        background: tokens.colors.bg.primary,
        opacity: isLoading ? 0.6 : 1,
      }}
    >
      <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        <Box>
          <Text size="sm" weight="medium">
            {t('enablePushNotifications')}
          </Text>
          {isDenied && (
            <Text size="xs" color="tertiary">
              {t('allowNotificationPermission')}
            </Text>
          )}
        </Box>
      </Box>
      {!(isDenied || isLoading) ? (
        <ToggleSwitch checked={isOn} onChange={handleToggle} />
      ) : (
        <Box style={{ opacity: 0.4, pointerEvents: 'none' }}>
          <ToggleSwitch checked={isOn} onChange={() => {}} />
        </Box>
      )}
    </Box>
  )
}
