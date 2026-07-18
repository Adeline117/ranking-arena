'use client'

import { Suspense, useCallback, useEffect, useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'
import { supabase } from '@/lib/supabase/client'
import { trackEvent } from '@/lib/analytics/track'
import { tipPostHref } from './tip-success-links'

const AUTO_REDIRECT_SECONDS = 15

interface TipDetails {
  amountCents: number | null
  handle: string | null
  postId: string | null
  postTitle: string | null
}

function TipSuccessContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const { t } = useLanguage()
  const { showToast } = useToast()
  const [countdown, setCountdown] = useState(AUTO_REDIRECT_SECONDS)
  const [dismissed, setDismissed] = useState(false)
  const [details, setDetails] = useState<TipDetails | null>(null)
  // True only once a real tip row is confirmed in the DB via session_id.
  // Gates the "receipt emailed" reassurance so we never claim a receipt was
  // sent for a tip we can't confirm actually happened.
  const [verified, setVerified] = useState(false)
  const sessionId = searchParams.get('session_id')

  // A credential = a Stripe session_id OR the forward-compat query params the
  // real tip flow appends. Bare access (nothing) must NOT fabricate success.
  const hasCredential = !!(
    sessionId ||
    searchParams.get('amount') ||
    searchParams.get('amount_cents') ||
    searchParams.get('to') ||
    searchParams.get('handle') ||
    searchParams.get('post_id')
  )

  // 优先读取 query 参数（前向兼容），否则按 session_id 查询打赏记录
  useEffect(() => {
    const qpAmount = searchParams.get('amount') ?? searchParams.get('amount_cents')
    const qpHandle = searchParams.get('to') ?? searchParams.get('handle')
    const qpPostId = searchParams.get('post_id')

    if (qpAmount || qpHandle || qpPostId) {
      setDetails({
        amountCents: qpAmount ? Number(qpAmount) : null,
        handle: qpHandle ? qpHandle.replace(/^@/, '') : null,
        postId: qpPostId,
        postTitle: null,
      })
    }

    if (!sessionId) return

    let cancelled = false
    ;(async () => {
      try {
        const { data: tip } = await supabase
          .from('tips')
          .select('amount_cents, post_id, to_user_id')
          .eq('stripe_checkout_session_id', sessionId)
          .maybeSingle()

        if (cancelled || !tip) return

        let handle: string | null = null
        let postTitle: string | null = null
        if (tip.post_id) {
          const { data: post } = await supabase
            .from('posts')
            .select('author_handle, title')
            .eq('id', tip.post_id)
            .maybeSingle()
          if (post) {
            handle = post.author_handle
            postTitle = post.title
          }
        }

        if (cancelled) return
        setVerified(true)
        setDetails({
          amountCents: tip.amount_cents,
          handle,
          postId: tip.post_id,
          postTitle,
        })
      } catch {
        // Intentionally swallowed: tip detail lookup is non-critical enrichment;
        // the success confirmation renders fine without it.
      }
    })()

    return () => {
      cancelled = true
    }
  }, [sessionId, searchParams])

  // 自动跳转（可关闭 / 已延长至 15s）
  useEffect(() => {
    if (dismissed) return
    if (countdown <= 0) {
      router.push('/')
      return
    }
    const timer = setTimeout(() => setCountdown((prev) => prev - 1), 1000)
    return () => clearTimeout(timer)
  }, [countdown, dismissed, router])

  const formattedAmount =
    details?.amountCents != null ? `$${(details.amountCents / 100).toFixed(2)}` : null
  const postId = details?.postId ?? null
  const handle = details?.handle ?? null
  const postHref = tipPostHref(postId)

  const handleShare = useCallback(async () => {
    const url = typeof window !== 'undefined' ? `${window.location.origin}${postHref ?? ''}` : ''
    const text = handle ? t('tipShareText').replace('{handle}', handle) : t('tipShareTextGeneric')
    trackEvent('tip_share', { has_handle: handle ? 1 : 0 })
    try {
      if (typeof navigator !== 'undefined' && navigator.share) {
        await navigator.share({ title: t('tipSuccess'), text, url })
        return
      }
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(url ? `${text} ${url}` : text)
        showToast(t('copied'), 'success')
      }
    } catch {
      // Intentionally swallowed: user cancelled share sheet or clipboard denied — no action needed.
    }
  }, [handle, postHref, t, showToast])

  // Bare access with no credential — show a neutral "no tip found" state
  // instead of fabricating "Tip Successful! / receipt emailed".
  if (!hasCredential) {
    return (
      <div
        className="min-h-screen flex items-center justify-center px-4"
        style={{ background: 'var(--color-bg-primary)' }}
      >
        <div className="text-center max-w-md">
          <h1 className="text-2xl font-bold mb-2" style={{ color: 'var(--color-text-primary)' }}>
            {t('tipNoRecordTitle')}
          </h1>
          <p style={{ color: 'var(--color-text-secondary)', marginBottom: 24 }}>
            {t('tipNoRecordDesc')}
          </p>
          <Link
            href="/"
            className="block w-full rounded-lg py-3 text-sm font-medium transition-colors"
            style={{ background: 'var(--color-accent-primary)', color: 'var(--foreground)' }}
          >
            {t('backToHome')}
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4"
      style={{ background: 'var(--color-bg-primary)' }}
    >
      <div className="text-center max-w-md">
        {/* 成功图标 */}
        <div className="mb-6 flex justify-center">
          <div
            className="w-20 h-20 rounded-full flex items-center justify-center"
            style={{ background: 'var(--color-accent-success-20)' }}
          >
            <svg
              className="w-10 h-10"
              style={{ color: 'var(--color-accent-success)' }}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 13l4 4L19 7"
              />
            </svg>
          </div>
        </div>

        <h1 className="text-2xl font-bold mb-2" style={{ color: 'var(--color-text-primary)' }}>
          {t('tipSuccess')}
        </h1>

        {/* 金额 + 收款人确认 */}
        {formattedAmount ? (
          <p className="text-lg font-semibold mb-2" style={{ color: 'var(--color-text-primary)' }}>
            {handle
              ? t('tipSentAmountTo')
                  .replace('{amount}', formattedAmount)
                  .replace('{handle}', handle)
              : t('tipSentAmount').replace('{amount}', formattedAmount)}
          </p>
        ) : null}

        <p style={{ color: 'var(--color-text-secondary)', marginBottom: 24 }}>
          {t('tipSuccessMessage')}
        </p>

        {/* Explicit inline spacing — this page's Tailwind spacing utilities were
            collapsing, leaving the button overlapping the text. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* 主操作：返回原帖（有 post_id 时），否则返回社区 */}
          <Link
            href={postHref ?? '/groups'}
            className="block w-full rounded-lg py-3 text-sm font-medium transition-colors"
            style={{ background: 'var(--color-accent-primary)', color: 'var(--foreground)' }}
          >
            {postId ? t('backToPost') : t('backToFeed')}
          </Link>

          {/* 一键分享支持 */}
          <button
            type="button"
            onClick={handleShare}
            className="block w-full rounded-lg py-3 text-sm font-medium transition-colors"
            style={{
              background: 'transparent',
              border: '1px solid var(--color-border-primary)',
              color: 'var(--color-text-primary)',
              cursor: 'pointer',
            }}
          >
            {t('tipShareCta')}
          </button>

          <Link
            href="/"
            className="block w-full py-2 text-sm font-medium transition-colors"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            {t('backToHome')}
          </Link>

          {!dismissed ? (
            <p className="text-sm" style={{ color: 'var(--color-text-tertiary)' }}>
              {t('redirectingCountdown').replace('{seconds}', String(countdown))}{' '}
              <button
                type="button"
                onClick={() => setDismissed(true)}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  color: 'var(--color-accent-primary)',
                  cursor: 'pointer',
                  font: 'inherit',
                }}
              >
                {t('stayOnPage')}
              </button>
            </p>
          ) : null}
        </div>

        {/* 收据安心提示 — 仅在 DB 确认打赏记录后显示,不对无法确认的打赏谎报收据 */}
        {verified ? (
          <p className="mt-6 text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
            {t('receiptEmailed')}
          </p>
        ) : null}
      </div>
    </div>
  )
}

export default function TipSuccessPage() {
  return (
    <Suspense
      fallback={
        <div
          className="min-h-screen flex items-center justify-center"
          style={{ background: 'var(--color-bg-primary)' }}
        >
          <div className="text-center" style={{ color: 'var(--color-text-secondary)' }}>
            Loading...
          </div>
        </div>
      }
    >
      <TipSuccessContent />
    </Suspense>
  )
}
