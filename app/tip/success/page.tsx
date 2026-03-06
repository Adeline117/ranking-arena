'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

function TipSuccessContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const { t } = useLanguage()
  const [countdown, setCountdown] = useState(5)
  const sessionId = searchParams.get('session_id')

  useEffect(() => {
    // 5秒后自动跳转到首页
    const timer = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          clearInterval(timer)
          router.push('/')
          return 0
        }
        return prev - 1
      })
    }, 1000)

    return () => clearInterval(timer)
  }, [router])

  return (
    <div className="min-h-screen flex items-center justify-center px-4" style={{ background: 'var(--color-bg-primary)' }}>
      <div className="text-center max-w-md">
        {/* 成功图标 */}
        <div className="mb-6 flex justify-center">
          <div className="w-20 h-20 rounded-full flex items-center justify-center" style={{ background: 'var(--color-accent-success-20)' }}>
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

        <p className="mb-6" style={{ color: 'var(--color-text-secondary)' }}>
          {t('tipSuccessMessage')}
        </p>

        <div className="space-y-3">
          <Link
            href="/"
            className="block w-full rounded-lg py-3 text-sm font-medium transition-colors"
            style={{ background: 'var(--color-accent-primary)', color: 'var(--foreground)' }}
          >
            {t('backToHome')}
          </Link>

          <p className="text-sm" style={{ color: 'var(--color-text-tertiary)' }}>
            {t('redirectingCountdown').replace('{seconds}', String(countdown))}
          </p>
        </div>

        {sessionId && (
          <p className="mt-6 text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
            {t('orderNumber')}: {sessionId.slice(0, 20)}...
          </p>
        )}
      </div>
    </div>
  )
}

export default function TipSuccessPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--color-bg-primary)' }}>
        <div className="text-center" style={{ color: 'var(--color-text-secondary)' }}>Loading...</div>
      </div>
    }>
      <TipSuccessContent />
    </Suspense>
  )
}
