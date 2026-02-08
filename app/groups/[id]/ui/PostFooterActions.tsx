"use client"

import React, { useState } from "react";
import { ThumbsUpIcon, CommentIcon } from "@/app/components/ui/icons";
import { useToast } from '@/app/components/ui/Toast';
import { useLanguage } from '@/app/components/Providers/LanguageProvider';
import { getCsrfHeaders } from '@/lib/api/client';
import { supabase } from '@/lib/supabase/client';

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
  const { language, t } = useLanguage()
  const [showTipModal, setShowTipModal] = useState(false)
  const [selectedAmount, setSelectedAmount] = useState(100)
  const [loading, setLoading] = useState(false)

  const handleTip = async () => {
    setLoading(true)
    try {
      // 获取用户 session
      // eslint-disable-next-line no-restricted-syntax -- TODO: migrate to useAuthSession()
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
      console.error('Tip error:', error)
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
          className="ml-auto rounded-md border border-white/10 bg-white/5 px-2 py-1 hover:bg-white/10 transition-colors"
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
            className="w-full max-w-sm rounded-lg bg-[#1a1a2e] p-6 shadow-xl"
            onClick={e => e.stopPropagation()}
          >
            <h3 className="mb-4 text-lg font-semibold text-white">
              {t('tipAuthor')} @{post.author_handle ?? "user"}
            </h3>
            
            <p className="mb-4 text-sm text-gray-400">
              {t('selectTipAmount')}
            </p>

            <div className="mb-6 grid grid-cols-4 gap-2">
              {TIP_AMOUNTS.map(({ cents, label }) => (
                <button
                  key={cents}
                  className={`rounded-lg py-2 text-sm font-medium transition-colors ${
                    selectedAmount === cents
                      ? 'bg-purple-600 text-white'
                      : 'bg-white/10 text-gray-300 hover:bg-white/20'
                  }`}
                  onClick={() => setSelectedAmount(cents)}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="flex gap-3">
              <button
                className="flex-1 rounded-lg bg-white/10 py-2.5 text-sm font-medium text-gray-300 hover:bg-white/20 transition-colors"
                onClick={() => setShowTipModal(false)}
              >
                {t('cancel')}
              </button>
              <button
                className="flex-1 rounded-lg bg-purple-600 py-2.5 text-sm font-medium text-white hover:bg-purple-700 transition-colors disabled:opacity-50"
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
