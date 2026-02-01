'use client'

import { useState, useEffect, useRef } from 'react'
import { supabase } from '@/lib/supabase/client'
import { useToast } from './Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

type FavoriteButtonProps = {
  traderId: string
  userId: string | null
  initialFavorited?: boolean
}

export default function FavoriteButton({ traderId, userId, initialFavorited = false }: FavoriteButtonProps) {
  const { showToast } = useToast()
  const { t } = useLanguage()
  const [favorited, setFavorited] = useState(initialFavorited)
  const [loading, setLoading] = useState(false)
  const pendingRef = useRef(false)

  useEffect(() => {
    if (!userId) return
    const controller = new AbortController()

    ;(async () => {
      try {
        const { data } = await supabase
          .from('favorites')
          .select('*')
          .eq('user_id', userId)
          .eq('trader_id', traderId)
          .maybeSingle()

        if (!controller.signal.aborted) {
          setFavorited(!!data)
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          console.error('Check favorite error:', error)
        }
      }
    })()

    return () => controller.abort()
  }, [userId, traderId])

  const handleToggle = async () => {
    if (!userId) {
      showToast(t('pleaseLogin'), 'warning')
      return
    }

    if (pendingRef.current) {
      return
    }
    pendingRef.current = true
    setLoading(true)

    const previousState = favorited
    const newState = !favorited

    setFavorited(newState)

    try {
      if (previousState) {
        const { error } = await supabase
          .from('favorites')
          .delete()
          .eq('user_id', userId)
          .eq('trader_id', traderId)
        if (error) throw error
        showToast(t('unbookmarked'), 'success')
      } else {
        const { error } = await supabase
          .from('favorites')
          .insert({ user_id: userId, trader_id: traderId })
        if (error) throw error
        showToast(t('bookmarked'), 'success')
      }
    } catch (error) {
      console.error('Toggle favorite error:', error)
      setFavorited(previousState)
      showToast(t('operationFailedRetry'), 'error')
    } finally {
      setLoading(false)
      pendingRef.current = false
    }
  }

  return (
    <button
      onClick={handleToggle}
      disabled={!userId || loading}
      aria-label={favorited ? t('removeBookmark') : t('bookmark')}
      aria-pressed={favorited}
      style={{
        padding: '10px 14px',
        borderRadius: '8px',
        border: 'none',
        background: 'transparent',
        color: favorited ? '#ff7c7c' : '#9a9a9a',
        cursor: userId && !loading ? 'pointer' : 'not-allowed',
        fontSize: '20px',
        minHeight: '44px',
        minWidth: '44px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'all 200ms ease',
      }}
      title={favorited ? t('removeBookmark') : t('bookmark')}
    >
      <span aria-hidden="true">{favorited ? '\u2605' : '\u2606'}</span>
    </button>
  )
}
