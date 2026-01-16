"use client"

import { useEffect } from "react"
import Link from "next/link"

const ARENA_PURPLE = '#8b6fa8'

// 页面级别的错误边界（不包含 html/body 标签）
export default function Error({ 
  error, 
  reset 
}: { 
  error: Error & { digest?: string }
  reset: () => void 
}) {
  useEffect(() => {
    // 生产环境可以发送到错误监控服务
    console.error("[Error]", error)
  }, [error])

  return (
    <div style={{ 
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24, 
      color: '#EDEDED', 
      background: '#0B0A10',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    }}>
      {/* 错误图标 */}
      <div style={{
        width: 80,
        height: 80,
        borderRadius: '50%',
        background: 'rgba(255, 124, 124, 0.1)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 24,
      }}>
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#ff7c7c" strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      </div>

      <h1 style={{ 
        fontSize: 28, 
        fontWeight: 700,
        marginBottom: 12,
        background: `linear-gradient(135deg, #EDEDED 0%, ${ARENA_PURPLE} 100%)`,
        WebkitBackgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
      }}>
        出错了
      </h1>
      
      <p style={{ 
        opacity: 0.7, 
        marginBottom: 8,
        fontSize: 14,
        textAlign: 'center',
        maxWidth: 400,
      }}>
        抱歉，页面遇到了一些问题。请尝试刷新页面或稍后再试。
      </p>
      
      {error.digest && (
        <p style={{
          fontSize: 12,
          opacity: 0.4,
          marginBottom: 24,
          fontFamily: 'monospace',
        }}>
          错误代码: {error.digest}
        </p>
      )}

      <div style={{ display: 'flex', gap: 12 }}>
        <button 
          onClick={() => reset()} 
          style={{ 
            padding: '12px 24px', 
            background: ARENA_PURPLE,
            color: '#fff', 
            borderRadius: 8,
            border: 'none',
            cursor: 'pointer',
            fontSize: 14,
            fontWeight: 600,
            transition: 'all 0.2s ease',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = '#9d84b5'
            e.currentTarget.style.transform = 'translateY(-2px)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = ARENA_PURPLE
            e.currentTarget.style.transform = 'translateY(0)'
          }}
        >
          重试
        </button>
        
        <Link 
          href="/"
          style={{ 
            padding: '12px 24px', 
            background: 'transparent',
            color: '#EDEDED', 
            borderRadius: 8,
            border: '1px solid rgba(255,255,255,0.2)',
            textDecoration: 'none',
            fontSize: 14,
            fontWeight: 500,
            transition: 'all 0.2s ease',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = ARENA_PURPLE
            e.currentTarget.style.color = ARENA_PURPLE
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = 'rgba(255,255,255,0.2)'
            e.currentTarget.style.color = '#EDEDED'
          }}
        >
          返回首页
        </Link>
      </div>
    </div>
  )
}
