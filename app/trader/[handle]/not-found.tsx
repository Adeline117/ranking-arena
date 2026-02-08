import Link from 'next/link'

export default function TraderNotFound() {
  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '40px 20px',
      textAlign: 'center',
      background: 'var(--color-bg-primary, #0B0A10)',
      color: 'var(--color-text-primary, #EDEDED)',
    }}>
      <img
        src="/stickers/confused.png"
        alt=""
        width={96}
        height={96}
        style={{ marginBottom: 24, opacity: 0.8 }}
      />
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>
        交易员不存在
      </h1>
      <p style={{ fontSize: 14, color: 'var(--color-text-secondary, #A8A8B3)', marginBottom: 24 }}>
        Trader not found. The profile may have been removed or the link is incorrect.
      </p>
      <Link
        href="/"
        style={{
          padding: '10px 28px',
          borderRadius: 8,
          background: 'var(--color-brand, #8b6fa8)',
          color: '#fff',
          textDecoration: 'none',
          fontWeight: 600,
          fontSize: 14,
        }}
      >
        返回首页
      </Link>
    </div>
  )
}
