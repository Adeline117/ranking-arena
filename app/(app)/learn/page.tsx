import type { Metadata } from 'next'
import Link from 'next/link'
import { ARTICLES } from './articles'
import PageHeader from '@/app/components/ui/PageHeader'
import { getServerTranslation } from '@/lib/i18n/server'

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

  return (
    <div style={{ maxWidth: 800, margin: '0 auto', padding: '40px 20px 80px' }}>
      <style
        dangerouslySetInnerHTML={{
          __html: `
.learnChip{padding:6px 14px;border-radius:999px;border:1px solid var(--color-border-primary,rgba(255,255,255,0.1));background:transparent;color:var(--color-text-secondary,#aaa);font-size:13px;cursor:pointer;transition:all .15s ease}
.learnChip.chip-active{background:var(--color-accent-primary,#8B6FA8);border-color:var(--color-accent-primary,#8B6FA8);color:#fff}
.learnCardHidden{display:none!important}
`,
        }}
      />

      <PageHeader title={t('learnPageTitle')} subtitle={t('learnPageSubtitle')} />

      {/* Search */}
      <input
        id="learn-search"
        type="search"
        placeholder={t('learnSearchArticles')}
        aria-label={t('search')}
        style={{
          width: '100%',
          padding: '12px 16px',
          borderRadius: 12,
          border: '1px solid var(--color-border-primary, rgba(255,255,255,0.1))',
          background: 'var(--color-bg-secondary, #1a1a2e)',
          color: 'var(--color-text-primary, #fff)',
          fontSize: 15,
          marginBottom: 16,
          outline: 'none',
        }}
      />

      {/* Topic chips */}
      {presentTopics.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 24 }}>
          <button type="button" className="learnChip chip-active" data-learn-chip data-topic="all">
            {t('all')}
          </button>
          {presentTopics.map((topic) => (
            <button
              key={topic}
              type="button"
              className="learnChip"
              data-learn-chip
              data-topic={topic}
            >
              {t(TOPIC_LABEL_KEY[topic])}
            </button>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {ARTICLES.map((article) => {
          const topic = TOPIC_BY_SLUG[article.slug] || ''
          const mins = readingMinutes(article.content)
          return (
            <Link
              key={article.slug}
              href={`/learn/${article.slug}`}
              data-learn-card
              data-topic={topic}
              data-search={`${article.title} ${article.excerpt}`.toLowerCase()}
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
              <div
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  justifyContent: 'space-between',
                  gap: 12,
                  marginBottom: 6,
                }}
              >
                <h2
                  style={{
                    fontSize: 18,
                    fontWeight: 600,
                    color: 'var(--color-text-primary, #fff)',
                    margin: 0,
                  }}
                >
                  {article.title}
                </h2>
                <span
                  style={{
                    flexShrink: 0,
                    fontSize: 12,
                    color: 'var(--color-text-tertiary, #888)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {mins} {t('learnMinRead')}
                </span>
              </div>
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
          )
        })}
      </div>

      {/* Empty state (shown by the filter script when nothing matches) */}
      <p
        id="learn-empty"
        style={{
          display: 'none',
          textAlign: 'center',
          color: 'var(--color-text-tertiary, #888)',
          fontSize: 14,
          padding: '32px 0',
        }}
      >
        {t('noResults')}
      </p>

      {/* Progressive enhancement: instant client-side filtering.
          If blocked/unsupported, all cards remain visible (no broken state). */}
      <script
        dangerouslySetInnerHTML={{
          __html: `(function(){
var q="",topic="all";
var input=document.getElementById("learn-search");
var empty=document.getElementById("learn-empty");
var cards=[].slice.call(document.querySelectorAll("[data-learn-card]"));
var chips=[].slice.call(document.querySelectorAll("[data-learn-chip]"));
function apply(){var n=0;cards.forEach(function(c){var s=c.getAttribute("data-search")||"";var tp=c.getAttribute("data-topic")||"";var ok=(topic==="all"||tp===topic)&&(q===""||s.indexOf(q)!==-1);if(ok){c.classList.remove("learnCardHidden");n++;}else{c.classList.add("learnCardHidden");}});if(empty)empty.style.display=n===0?"block":"none";}
if(input)input.addEventListener("input",function(e){q=(e.target.value||"").toLowerCase().trim();apply();});
chips.forEach(function(ch){ch.addEventListener("click",function(){topic=ch.getAttribute("data-topic")||"all";chips.forEach(function(x){if(x===ch){x.classList.add("chip-active");}else{x.classList.remove("chip-active");}});apply();});});
})();`,
        }}
      />
    </div>
  )
}
