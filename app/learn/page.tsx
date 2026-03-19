import type { Metadata } from 'next'
import Link from 'next/link'
import { ARTICLES } from './articles'

export const revalidate = 3600

export const metadata: Metadata = {
  title: 'Learn | Arena',
  description:
    'Learn how Arena scores traders, how rankings work, and how to read risk metrics like drawdown, Sharpe ratio, and win rate.',
}

export default function LearnPage() {
  return (
    <div
      style={{
        maxWidth: 800,
        margin: '0 auto',
        padding: '40px 20px 80px',
      }}
    >
      <h1
        style={{
          fontSize: 28,
          fontWeight: 700,
          color: 'var(--color-text-primary, #fff)',
          marginBottom: 8,
        }}
      >
        Learn
      </h1>
      <p
        style={{
          fontSize: 15,
          color: 'var(--color-text-secondary, #aaa)',
          marginBottom: 32,
          lineHeight: 1.6,
        }}
      >
        Understand how Arena works, how we rank traders, and how to read the metrics.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {ARTICLES.map(article => (
          <Link
            key={article.slug}
            href={`/learn/${article.slug}`}
            style={{
              display: 'block',
              padding: '20px 24px',
              borderRadius: 12,
              border: '1px solid var(--color-border-primary, rgba(255,255,255,0.1))',
              background: 'var(--color-bg-secondary, #1a1a2e)',
              textDecoration: 'none',
              transition: 'border-color 0.2s ease, transform 0.2s ease',
            }}
          >
            <h2
              style={{
                fontSize: 18,
                fontWeight: 600,
                color: 'var(--color-text-primary, #fff)',
                marginBottom: 6,
                marginTop: 0,
              }}
            >
              {article.title}
            </h2>
            <p
              style={{
                fontSize: 14,
                color: 'var(--color-text-secondary, #aaa)',
                margin: 0,
                lineHeight: 1.5,
              }}
            >
              {article.excerpt}
            </p>
          </Link>
        ))}
      </div>
    </div>
  )
}
