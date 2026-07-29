'use client'

import { useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useToast } from '@/app/components/ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { buildConversationLoginHref } from '../login-intent'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { captureSettingsViewer } from '@/app/(app)/settings/hooks/settings-viewer-scope'

export function useConversationAuth(conversationId: string) {
  const router = useRouter()
  const { showToast } = useToast()
  const { t } = useLanguage()
  const auth = useAuthSession()
  const authRef = useRef(auth)
  authRef.current = auth
  const viewer = captureSettingsViewer(auth)
  const authChecked = auth.authChecked && !auth.loading && (viewer !== null || auth.userId === null)

  const ensureAuth = useCallback(async (): Promise<{
    userId: string
    accessToken: string
  } | null> => {
    const currentViewer = captureSettingsViewer(authRef.current)
    if (currentViewer) {
      return {
        userId: currentViewer.userId,
        accessToken: currentViewer.accessToken,
      }
    }
    // A principal transition is neither authenticated nor signed out. Do not
    // redirect while another account is still being restored.
    if (
      !authRef.current.authChecked ||
      authRef.current.loading ||
      Boolean(authRef.current.userId)
    ) {
      return null
    }
    showToast(t('loginExpiredPleaseRelogin'), 'error')
    router.push(buildConversationLoginHref(conversationId))
    return null
  }, [conversationId, showToast, t, router])

  return {
    email: viewer?.email ?? null,
    userId: viewer?.userId ?? null,
    authChecked,
    accessToken: viewer?.accessToken ?? null,
    ensureAuth,
  }
}
