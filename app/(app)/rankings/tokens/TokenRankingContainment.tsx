import { getServerTranslation } from '@/lib/i18n/server'
import { TOKEN_RANKING_NOT_PUBLISHED_CODE } from '@/lib/rankings/token-ranking-containment'
import { tokens } from '@/lib/design-tokens'

export default async function TokenRankingContainment() {
  const { t } = await getServerTranslation()

  return (
    <main
      data-token-ranking-containment={TOKEN_RANKING_NOT_PUBLISHED_CODE}
      style={{
        minHeight: '55vh',
        display: 'grid',
        placeItems: 'center',
        padding: '48px 16px',
      }}
    >
      <section
        aria-labelledby="token-ranking-containment-title"
        style={{
          width: 'min(100%, 640px)',
          padding: '32px',
          border: `1px solid ${tokens.colors.border.primary}`,
          borderRadius: tokens.radius.xl,
          background: tokens.colors.bg.secondary,
          textAlign: 'center',
        }}
      >
        <p
          style={{
            margin: '0 0 12px',
            color: tokens.colors.text.secondary,
            fontSize: tokens.typography.fontSize.sm,
            fontWeight: tokens.typography.fontWeight.bold,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
          }}
        >
          {t('tokenRankingsContainmentLabel')}
        </p>
        <h1
          id="token-ranking-containment-title"
          style={{ margin: '0 0 16px', fontSize: 'clamp(28px, 5vw, 40px)', lineHeight: 1.15 }}
        >
          {t('tokenRankingsContainmentTitle')}
        </h1>
        <p
          role="status"
          style={{
            margin: '0 auto 20px',
            maxWidth: 560,
            color: tokens.colors.text.secondary,
            fontSize: tokens.typography.fontSize.md,
            lineHeight: 1.65,
          }}
        >
          {t('tokenRankingsContainmentDescription')}
        </p>
        <code
          style={{
            display: 'inline-block',
            padding: '6px 10px',
            borderRadius: tokens.radius.md,
            background: tokens.colors.bg.tertiary,
            color: tokens.colors.text.secondary,
            fontSize: tokens.typography.fontSize.xs,
          }}
        >
          {TOKEN_RANKING_NOT_PUBLISHED_CODE}
        </code>
        <div style={{ marginTop: 24 }}>
          <a
            href="/"
            style={{
              color: tokens.colors.accent.brand,
              fontWeight: tokens.typography.fontWeight.bold,
              textDecoration: 'none',
            }}
          >
            {t('tokenRankingsContainmentBack')}
          </a>
        </div>
      </section>
    </main>
  )
}
