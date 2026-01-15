import Link from "next/link"

const ARENA_PURPLE = '#8b6fa8'

export default function NotFoundPage() {
  return (
    <div style={{ 
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
      background: '#0B0A10',
      color: '#EDEDED',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    }}>
      {/* 404 大数字 */}
      <div style={{
        fontSize: 120,
        fontWeight: 900,
        lineHeight: 1,
        marginBottom: 16,
        background: `linear-gradient(135deg, ${ARENA_PURPLE} 0%, rgba(139, 111, 168, 0.3) 100%)`,
        WebkitBackgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
        textShadow: `0 0 60px rgba(139, 111, 168, 0.3)`,
      }}>
        404
      </div>

      <h1 style={{ 
        fontSize: 24, 
        fontWeight: 700,
        marginBottom: 12,
      }}>
        页面不存在
      </h1>
      
      <p style={{ 
        opacity: 0.6, 
        marginBottom: 32,
        fontSize: 14,
        textAlign: 'center',
        maxWidth: 400,
      }}>
        您访问的页面可能已被移动、删除，或者链接有误。
      </p>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', justifyContent: 'center' }}>
        <Link 
          href="/"
          style={{ 
            padding: '12px 24px', 
            background: ARENA_PURPLE,
            color: '#fff', 
            borderRadius: 8,
            textDecoration: 'none',
            fontSize: 14,
            fontWeight: 600,
            transition: 'all 0.2s ease',
          }}
        >
          返回首页
        </Link>
        
        <Link 
          href="/hot"
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
        >
          查看热榜
        </Link>
        
        <Link 
          href="/groups"
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
        >
          浏览小组
        </Link>
      </div>

      {/* 装饰背景 */}
      <div style={{
        position: 'fixed',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        width: 600,
        height: 600,
        background: `radial-gradient(circle, rgba(139, 111, 168, 0.1) 0%, transparent 70%)`,
        pointerEvents: 'none',
        zIndex: -1,
      }} />
    </div>
  )
}
