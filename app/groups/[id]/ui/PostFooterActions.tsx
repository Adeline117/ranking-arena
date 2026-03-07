"use client"

import React, { useState } from "react";
import { ThumbsUpIcon, CommentIcon } from "@/app/components/ui/icons";
import { useToast } from '@/app/components/ui/Toast';
import { useLanguage } from '@/app/components/Providers/LanguageProvider';
import { getCsrfHeaders } from '@/lib/api/client';
import { supabase } from '@/lib/supabase/client';
import { logger } from '@/lib/logger'

type Post = {
  id: string
  author_handle?: string | null
  like_count?: number | null
  comment_count?: number | null
}

// 打赏金额选项
const TIP_AMOUNTS = [
  { cents: 100, label: '$1' },
  { cents: 300, label: '$3' },
  { cents: 500, label: '$5' },
  { cents: 1000, label: '$10' },
]

export default function PostFooterActions({ post }: { post: Post }) {
  const { showToast } = useToast()
  const { language: _language, t } = useLanguage()
  const [showTipModal, setShowTipModal] = useState(false)
  const [selectedAmount, setSelectedAmount] = useState(100)
  const [loading, setLoading] = useState(false)

  const handleTip = async () => {
    setLoading(true)
    try {
      // 获取用户 session
       
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token

      if (!token) {
        showToast(t('loginToTip'), 'warning')
        setShowTipModal(false)
        return
      }

      const res = await fetch("/api/tip/checkout", {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({
          post_id: post.id,
          amount_cents: selectedAmount,
        }),
      })

      const json = await res.json()
      
      if (!res.ok) {
        showToast(json.error || t('createPaymentFailed'), 'error')
        return
      }

      // 重定向到 Stripe Checkout
      if (json.url) {
        window.location.href = json.url
      }
    } catch (error) {
      logger.error('Tip error:', error)
      showToast(t('tipFailed'), 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <div className="mt-3 flex items-center gap-4 text-xs opacity-70">
        <span>@{post.author_handle ?? "user"}</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <ThumbsUpIcon size={12} /> {post.like_count ?? 0}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <CommentIcon size={12} /> {post.comment_count ?? 0}
        </span>

        <button
          className="ml-auto rounded-md px-2 py-1 transition-colors"
          style={{ border: '1px solid var(--color-border-primary)', background: 'var(--color-bg-tertiary)' }}
          onClick={() => setShowTipModal(true)}
        >
          {t('tip')}
        </button>
      </div>

      {/* 打赏弹窗 */}
      {showTipModal && (
        <div 
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setShowTipModal(false)}
        >
          <div 
            className="w-full max-w-sm rounded-lg p-6"
            style={{ background: 'var(--color-bg-secondary)', boxShadow: 'var(--shadow-elevated)' }}
            onClick={e => e.stopPropagation()}
          >
            <h3 className="mb-4 text-lg font-semibold" style={{ color: 'var(--color-text-primary)' }}>
              {t('tipAuthor')} @{post.author_handle ?? "user"}
            </h3>
            
            <p className="mb-4 text-sm" style={{ color: 'var(--color-text-secondary)' }}>
              {t('selectTipAmount')}
            </p>

            <div className="mb-6 grid grid-cols-4 gap-2">
              {TIP_AMOUNTS.map(({ cents, label }) => (
                <button
                  key={cents}
                  className="rounded-lg py-2 text-sm font-medium transition-colors"
                  style={{
                    background: selectedAmount === cents ? 'var(--color-accent-primary)' : 'var(--color-bg-tertiary)',
                    color: selectedAmount === cents ? 'var(--color-on-accent)' : 'var(--color-text-secondary)',
                  }}
                  onClick={() => setSelectedAmount(cents)}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="flex gap-3">
              <button
                className="flex-1 rounded-lg py-2.5 text-sm font-medium transition-colors"
                style={{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-secondary)' }}
                onClick={() => setShowTipModal(false)}
              >
                {t('cancel')}
              </button>
              <button
                className="flex-1 rounded-lg py-2.5 text-sm font-medium transition-colors disabled:opacity-50"
                style={{ background: 'var(--color-accent-primary)', color: 'var(--foreground)' }}
                onClick={handleTip}
                disabled={loading}
              >
                {loading
                  ? t('processing')
                  : `${t('pay')} ${TIP_AMOUNTS.find(a => a.cents === selectedAmount)?.label}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
