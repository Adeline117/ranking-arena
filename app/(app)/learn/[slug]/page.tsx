import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ARTICLES, getArticleBySlug, pickLocalized } from '../articles'
import { getServerTranslation } from '@/lib/i18n/server'

export const revalidate = 3600

export function generateStaticParams() {
  return ARTICLES.map((a) => ({ slug: a.slug }))
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  const article = getArticleBySlug(slug)
  if (!article) return { title: 'Not Found' }
  const { lang } = await getServerTranslation()
  return {
    // `absolute` opts out of the root layout template ('%s | Arena'); this page
    // uses its own 'Arena Learn' branding suffix and must not have ' | Arena'
    // appended on top of it.
    title: { absolute: `${pickLocalized(article.title, lang)} | Arena Learn` },
    description: pickLocalized(article.excerpt, lang),
  }
}

interface Heading {
  level: number
  text: string
  id: string
}

/**
 * Slugify heading text into a stable, XSS-safe anchor id.
 * Output is restricted to [a-z0-9-] plus CJK, so it can never inject markup.
 */
function slugify(text: string): string {
  const base = text
    .toLowerCase()
    .replace(/[^\w一-龥]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return base || 'section'
}

/**
 * Minimal markdown-to-HTML renderer for learn articles.
 * Handles headings, paragraphs, lists, inline code, and code blocks.
 * Also collects headings (with stable anchor ids) for the table of contents.
 */
function renderArticle(md: string): { html: string; headings: Heading[] } {
  const lines = md.split('\n')
  const html: string[] = []
  const headings: Heading[] = []
  const usedIds = new Set<string>()
  let inList = false
  let inCodeBlock = false
  let codeContent: string[] = []

  for (const line of lines) {
    // Code blocks
    if (line.startsWith('```')) {
      if (inCodeBlock) {
        html.push(
          `<pre style="background:var(--color-bg-tertiary,#111);padding:16px;border-radius:8px;overflow-x:auto;font-size:13px;line-height:1.6;margin:16px 0"><code>${codeContent.join('\n')}</code></pre>`
        )
        codeContent = []
        inCodeBlock = false
      } else {
        if (inList) {
          html.push('</ul>')
          inList = false
        }
        inCodeBlock = true
      }
      continue
    }
    if (inCodeBlock) {
      codeContent.push(line.replace(/</g, '&lt;').replace(/>/g, '&gt;'))
      continue
    }

    const trimmed = line.trim()

    // Empty line
    if (!trimmed) {
      if (inList) {
        html.push('</ul>')
        inList = false
      }
      continue
    }

    // Headings
    const headingMatch = trimmed.match(/^(#{1,3})\s+(.+)/)
    if (headingMatch) {
      if (inList) {
        html.push('</ul>')
        inList = false
      }
      const level = headingMatch[1].length
      const text = headingMatch[2]
      // Plain text (markdown stripped) for the id + TOC label
      const plain = text.replace(/`/g, '').replace(/\*\*/g, '').trim()
      let id = slugify(plain)
      if (usedIds.has(id)) {
        let n = 2
        while (usedIds.has(`${id}-${n}`)) n++
        id = `${id}-${n}`
      }
      usedIds.add(id)
      // TOC lists section headings only (skip the h1 article title)
      if (level >= 2) headings.push({ level, text: plain, id })
      const sizes: Record<number, string> = { 1: '24px', 2: '20px', 3: '16px' }
      const margins: Record<number, string> = {
        1: '32px 0 16px',
        2: '28px 0 12px',
        3: '20px 0 8px',
      }
      html.push(
        `<h${level} id="${id}" style="font-size:${sizes[level]};font-weight:700;color:var(--color-text-primary,#fff);margin:${margins[level]}">${inlineFormat(text)}</h${level}>`
      )
      continue
    }

    // List items
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      if (!inList) {
        html.push('<ul style="padding-left:24px;margin:8px 0">')
        inList = true
      }
      html.push(
        `<li style="color:var(--color-text-primary,#fff);font-size:15px;line-height:1.7;margin:4px 0">${inlineFormat(trimmed.slice(2))}</li>`
      )
      continue
    }

    // Paragraph
    if (inList) {
      html.push('</ul>')
      inList = false
    }
    html.push(
      `<p style="color:var(--color-text-primary,#fff);font-size:15px;line-height:1.8;margin:12px 0">${inlineFormat(trimmed)}</p>`
    )
  }

  if (inList) html.push('</ul>')
  return { html: html.join('\n'), headings }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function inlineFormat(text: string): string {
  // Escape HTML first to prevent XSS (defense-in-depth)
  let result = escapeHtml(text)
  // Inline code
  result = result.replace(
    /`([^`]+)`/g,
    '<code style="background:var(--color-bg-tertiary,#111);padding:2px 6px;border-radius:4px;font-size:13px">$1</code>'
  )
  // Bold
  result = result.replace(
    /\*\*([^*]+)\*\*/g,
    '<strong style="color:var(--color-text-primary,#fff);font-weight:600">$1</strong>'
  )
  return result
}

export default async function LearnArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const article = getArticleBySlug(slug)
  if (!article) {
    notFound()
  }

  const { t, lang } = await getServerTranslation()

  // Dynamic import: keeps the sanitize-html parser off this page's cold-start
  // path so a sanitizer load failure can never turn the notFound() above into a 500.
  const { sanitizeHtml } = await import('@/lib/utils/sanitize')

  const { html, headings } = renderArticle(article.content)
  const showToc = headings.length >= 3

  // Prev / next navigation derived from the canonical ARTICLES order
  const idx = ARTICLES.findIndex((a) => a.slug === slug)
  const prev = idx > 0 ? ARTICLES[idx - 1] : null
  const next = idx >= 0 && idx < ARTICLES.length - 1 ? ARTICLES[idx + 1] : null

  return (
    <div style={{ maxWidth: 1040, margin: '0 auto', padding: '40px 20px 80px' }}>
      <style
        dangerouslySetInnerHTML={{
          __html: `
.learnArticleGrid{display:grid;grid-template-columns:1fr;gap:32px}
.learnArticleMain{max-width:720px;width:100%;margin:0 auto;min-width:0}
.learnArticleMain h1,.learnArticleMain h2,.learnArticleMain h3{scroll-margin-top:88px}
.learnToc{align-self:start}
.learnToc ol{list-style:none;margin:0;padding:0}
@media(min-width:1000px){
  .learnArticleGrid.hasToc{grid-template-columns:minmax(0,720px) 220px;justify-content:center}
  .learnToc{position:sticky;top:88px}
}
@media(max-width:999px){.learnToc{order:-1}}
`,
        }}
      />

      <Link
        href="/learn"
        style={{
          display: 'inline-block',
          fontSize: 14,
          color: 'var(--color-accent-primary, #8B6FA8)',
          textDecoration: 'none',
          marginBottom: 24,
        }}
      >
        ← {t('back')}
      </Link>

      <div className={`learnArticleGrid${showToc ? ' hasToc' : ''}`}>
        {/* Defense-in-depth: content is static markdown from ../articles.ts,
            but we sanitize anyway to guard against future content source changes. */}
        <article
          className="learnArticleMain"
          dangerouslySetInnerHTML={{
            __html: sanitizeHtml(html, {
              allowedTags: [
                'p',
                'br',
                'strong',
                'em',
                'b',
                'i',
                'h1',
                'h2',
                'h3',
                'ul',
                'ol',
                'li',
                'a',
                'code',
                'pre',
                'span',
              ],
              allowedAttr: ['href', 'target', 'rel', 'class', 'id'],
            }),
          }}
        />

        {showToc && (
          <aside className="learnToc">
            <div
              style={{
                padding: '16px 18px',
                borderRadius: 12,
                border: '1px solid var(--color-border-primary, rgba(255,255,255,0.1))',
                background: 'var(--color-bg-secondary, #1a1a2e)',
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  color: 'var(--color-text-tertiary, #888)',
                  marginBottom: 12,
                }}
              >
                {t('learnOnThisPage')}
              </div>
              <ol>
                {headings.map((h) => (
                  <li key={h.id} style={{ margin: '6px 0', marginLeft: h.level === 3 ? 12 : 0 }}>
                    <a
                      href={`#${h.id}`}
                      style={{
                        fontSize: h.level === 3 ? 13 : 14,
                        lineHeight: 1.5,
                        color: 'var(--color-text-secondary, #aaa)',
                        textDecoration: 'none',
                      }}
                    >
                      {h.text}
                    </a>
                  </li>
                ))}
              </ol>
            </div>
          </aside>
        )}
      </div>

      {(prev || next) && (
        <nav
          style={{
            display: 'flex',
            gap: 16,
            marginTop: 48,
            paddingTop: 24,
            borderTop: '1px solid var(--color-border-primary, rgba(255,255,255,0.1))',
          }}
        >
          {prev && (
            <Link
              href={`/learn/${prev.slug}`}
              style={{
                flex: 1,
                display: 'block',
                padding: '14px 18px',
                borderRadius: 12,
                border: '1px solid var(--color-border-primary, rgba(255,255,255,0.1))',
                background: 'var(--color-bg-secondary, #1a1a2e)',
                textDecoration: 'none',
                textAlign: 'left',
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--color-text-tertiary, #888)',
                  marginBottom: 4,
                }}
              >
                ← {t('prev')}
              </div>
              <div
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  color: 'var(--color-text-primary, #fff)',
                }}
              >
                {pickLocalized(prev.title, lang)}
              </div>
            </Link>
          )}
          {next && (
            <Link
              href={`/learn/${next.slug}`}
              style={{
                flex: 1,
                display: 'block',
                padding: '14px 18px',
                borderRadius: 12,
                border: '1px solid var(--color-border-primary, rgba(255,255,255,0.1))',
                background: 'var(--color-bg-secondary, #1a1a2e)',
                textDecoration: 'none',
                textAlign: 'right',
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--color-text-tertiary, #888)',
                  marginBottom: 4,
                }}
              >
                {t('next')} →
              </div>
              <div
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  color: 'var(--color-text-primary, #fff)',
                }}
              >
                {pickLocalized(next.title, lang)}
              </div>
            </Link>
          )}
        </nav>
      )}
    </div>
  )
}
