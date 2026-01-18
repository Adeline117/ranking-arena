'use client'

import { useEffect, useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import Link from 'next/link'

export default function TipSuccessPage() {
  const searchParams = useSearchParams()
  const router = useRouter()
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
    <div className="min-h-screen bg-[#0a0a0f] flex items-center justify-center px-4">
      <div className="text-center max-w-md">
        {/* 成功图标 */}
        <div className="mb-6 flex justify-center">
          <div className="w-20 h-20 rounded-full bg-green-500/20 flex items-center justify-center">
            <svg 
              className="w-10 h-10 text-green-500" 
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

        <h1 className="text-2xl font-bold text-white mb-2">
          打赏成功！🎉
        </h1>
        
        <p className="text-gray-400 mb-6">
          感谢你对创作者的支持，你的打赏已成功发送。
        </p>

        <div className="space-y-3">
          <Link
            href="/"
            className="block w-full rounded-lg bg-purple-600 py-3 text-sm font-medium text-white hover:bg-purple-700 transition-colors"
          >
            返回首页
          </Link>
          
          <p className="text-sm text-gray-500">
            {countdown} 秒后自动返回首页...
          </p>
        </div>

        {sessionId && (
          <p className="mt-6 text-xs text-gray-600">
            订单号: {sessionId.slice(0, 20)}...
          </p>
        )}
      </div>
    </div>
  )
}
