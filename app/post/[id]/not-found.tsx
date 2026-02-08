import Link from 'next/link'

export default function PostNotFound() {
  return (
    <div style={{
      minHeight: '60vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '2rem',
      textAlign: 'center',
    }}>
      <h1 style={{ fontSize: '1.5rem', fontWeight: 'bold', marginBottom: '0.75rem', color: 'var(--color-text-primary)' }}>
        找不到该帖子
      </h1>
      <p style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)', marginBottom: '1.5rem' }}>
        该帖子不存在或已被删除。
      </p>
      <Link
        href="/"
        style={{
          padding: '0.5rem 1.5rem',
          fontSize: '0.875rem',
          color: '#fff',
          backgroundColor: 'var(--color-accent-primary)',
          borderRadius: '6px',
          textDecoration: 'none',
        }}
      >
        返回首页
      </Link>
    </div>
  )
}
