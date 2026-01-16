'use client'

/**
 * 离线页面
 * 当用户离线且没有缓存时显示
 */

export default function OfflinePage() {
  const handleRetry = () => {
    window.location.reload()
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem',
        backgroundColor: '#0B0A10',
        color: '#EDEDED',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      }}
    >
      <div
        style={{
          maxWidth: '400px',
          textAlign: 'center',
          padding: '2rem',
        }}
      >
        {/* 离线图标 */}
        <div
          style={{
            fontSize: '4rem',
            marginBottom: '1.5rem',
          }}
        >
          📡
        </div>
        
        <h1
          style={{
            fontSize: '1.5rem',
            fontWeight: 'bold',
            marginBottom: '1rem',
          }}
        >
          您已离线
        </h1>
        
        <p
          style={{
            fontSize: '0.875rem',
            color: '#A8A8B3',
            marginBottom: '2rem',
            lineHeight: 1.6,
          }}
        >
          请检查您的网络连接后重试。部分已缓存的内容可能仍可访问。
        </p>
        
        <button
          onClick={handleRetry}
          style={{
            padding: '0.75rem 2rem',
            fontSize: '0.875rem',
            fontWeight: '500',
            color: '#EDEDED',
            backgroundColor: '#8b6fa8',
            border: 'none',
            borderRadius: '8px',
            cursor: 'pointer',
            transition: 'background-color 0.2s',
          }}
          onMouseOver={(e) => {
            e.currentTarget.style.backgroundColor = '#9d84b5'
          }}
          onMouseOut={(e) => {
            e.currentTarget.style.backgroundColor = '#8b6fa8'
          }}
        >
          重试连接
        </button>
        
        <p
          style={{
            fontSize: '0.75rem',
            color: '#6B6B7B',
            marginTop: '2rem',
          }}
        >
          Ranking Arena - 加密货币交易员排行榜
        </p>
      </div>
    </div>
  )
}
