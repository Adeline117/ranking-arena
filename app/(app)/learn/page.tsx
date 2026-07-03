import type { Metadata } from 'next'
import Link from 'next/link'
import { ARTICLES } from './articles'
import PageHeader from '@/app/components/ui/PageHeader'
import { getServerTranslation } from '@/lib/i18n/server'
import LearnFilter from './LearnFilter'

export const revalidate = 3600

export const metadata: Metadata = {
  title: 'Learn',
  description:
    'Learn how Arena scores traders, how rankings work, and how to read risk metrics like drawdown, Sharpe ratio, and win rate.',
}

// Lightweight topic taxonomy for client-side filtering chips.
const TOPIC_BY_SLUG: Record<string, string> = {
  'how-arena-score-works': 'scoring',
  'understanding-trader-rankings': 'rankings',
  'cex-vs-dex': 'exchanges',
  'reading-risk-metrics': 'risk',
  'getting-started': 'basics',
  'top-traders-by-exchange': 'exchanges',
  'what-is-copy-trading': 'basics',
  'trading-styles-explained': 'basics',
  'how-to-read-equity-curves': 'risk',
  'arena-pro-features': 'pro',
}

const TOPIC_ORDER = ['scoring', 'rankings', 'exchanges', 'risk', 'basics', 'pro']

const TOPIC_LABEL_KEY: Record<string, string> = {
  scoring: 'learnTopicScoring',
  rankings: 'learnTopicRankings',
  exchanges: 'learnTopicExchanges',
  risk: 'learnTopicRisk',
  basics: 'learnTopicBasics',
  pro: 'learnTopicPro',
}

// ~200 words/min reading speed; floor of 1 minute.
function readingMinutes(content: string): number {
  const words = content.trim().split(/\s+/).filter(Boolean).length
  return Math.max(1, Math.round(words / 200))
}

export default async function LearnPage() {
  const { t } = await getServerTranslation()

  // Topics that actually appear in the current article set (preserves order).
  const presentTopics = TOPIC_ORDER.filter((topic) =>
    ARTICLES.some((a) => TOPIC_BY_SLUG[a.slug] === topic)
  )

  // Metadata only — article content stays server-side (not shipped to client).
  const cards = ARTICLES.map((article) => ({
    slug: article.slug,
    title: article.title,
    excerpt: article.excerpt,
    topic: TOPIC_BY_SLUG[article.slug] || '',
    mins: readingMinutes(article.content),
  }))

  return (
    <div style={{ maxWidth: 800, margin: '0 auto', padding: '40px 20px 80px' }}>
      <PageHeader title={t('learnPageTitle')} subtitle={t('learnPageSubtitle')} />

      {/* Quiz promo — entry point to the otherwise-orphaned /quiz personality test */}
      <Link
        href="/quiz"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          padding: '20px 24px',
          marginBottom: 24,
          borderRadius: 16,
          border: '1px solid var(--color-accent-primary, #8B6FA8)',
          background:
            'linear-gradient(135deg, var(--color-bg-secondary, #1a1a2e), rgba(139,111,168,0.12))',
          textDecoration: 'none',
        }}
      >
        <div style={{ minWidth: 0, flex: '1 1 260px' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 18,
              fontWeight: 700,
              color: 'var(--color-text-primary, #fff)',
              marginBottom: 4,
            }}
          >
            <span aria-hidden>🎯</span>
            {t('quizTitle')}
          </div>
          <p
            style={{
              fontSize: 14,
              color: 'var(--color-text-secondary, #aaa)',
              margin: 0,
              lineHeight: 1.5,
            }}
          >
            {t('quizSubtitle')}
          </p>
        </div>
        <span
          style={{
            flexShrink: 0,
            padding: '10px 20px',
            borderRadius: 999,
            background: 'var(--color-accent-primary, #8B6FA8)',
            color: '#fff',
            fontSize: 14,
            fontWeight: 600,
            whiteSpace: 'nowrap',
          }}
        >
          {t('quizStartBtn')} →
        </span>
      </Link>

      <LearnFilter
        articles={cards}
        topics={presentTopics.map((topic) => ({
          id: topic,
          label: t(TOPIC_LABEL_KEY[topic]),
        }))}
        labels={{
          all: t('all'),
          searchPlaceholder: t('learnSearchArticles'),
          searchAria: t('search'),
          noResults: t('noResults'),
          minRead: t('learnMinRead'),
        }}
      />
    </div>
  )
}
