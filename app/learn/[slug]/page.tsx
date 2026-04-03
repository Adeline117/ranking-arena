import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ARTICLES, getArticleBySlug } from '../articles'

export const revalidate = 3600

export function generateStaticParams() {
  return ARTICLES.map(a => ({ slug: a.slug }))
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  const article = getArticleBySlug(slug)
  if (!article) return { title: 'Not Found | Arena' }
  return {
    title: `${article.title} | Arena Learn`,
    description: article.excerpt,
  }
}

/**
 * Minimal markdown-to-HTML renderer for learn articles.
 * Handles headings, paragraphs, lists, inline code, and code blocks.
 */
function renderMarkdown(md: string): string {
  const lines = md.split('\n')
  const html: string[] = []
  let inList = false
  let inCodeBlock = false
  let codeContent: string[] = []

  for (const line of lines) {
    // Code blocks
    if (line.startsWith('```')) {
      if (inCodeBlock) {
        html.push(`<pre style="background:var(--color-bg-tertiary,#111);padding:16px;border-radius:8px;overflow-x:auto;font-size:13px;line-height:1.6;margin:16px 0"><code>${codeContent.join('\n')}</code></pre>`)
        codeContent = []
        inCodeBlock = false
      } else {
        if (inList) { html.push('</ul>'); inList = false }
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
      if (inList) { html.push('</ul>'); inList = false }
      continue
    }

    // Headings
    const headingMatch = trimmed.match(/^(#{1,3})\s+(.+)/)
    if (headingMatch) {
      if (inList) { html.push('</ul>'); inList = false }
      const level = headingMatch[1].length
      const text = headingMatch[2]
      const sizes: Record<number, string> = { 1: '24px', 2: '20px', 3: '16px' }
      const margins: Record<number, string> = { 1: '32px 0 16px', 2: '28px 0 12px', 3: '20px 0 8px' }
      html.push(`<h${level} style="font-size:${sizes[level]};font-weight:700;color:var(--color-text-primary,#fff);margin:${margins[level]}">${inlineFormat(text)}</h${level}>`)
      continue
    }

    // List items
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      if (!inList) { html.push('<ul style="padding-left:24px;margin:8px 0">'); inList = true }
      html.push(`<li style="color:var(--color-text-secondary,#aaa);font-size:15px;line-height:1.7;margin:4px 0">${inlineFormat(trimmed.slice(2))}</li>`)
      continue
    }

    // Paragraph
    if (inList) { html.push('</ul>'); inList = false }
    html.push(`<p style="color:var(--color-text-secondary,#aaa);font-size:15px;line-height:1.7;margin:12px 0">${inlineFormat(trimmed)}</p>`)
  }

  if (inList) html.push('</ul>')
  return html.join('\n')
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
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
  result = result.replace(/\*\*([^*]+)\*\*/g, '<strong style="color:var(--color-text-primary,#fff);font-weight:600">$1</strong>')
  return result
}

export default async function LearnArticlePage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const article = getArticleBySlug(slug)
  if (!article) notFound()

  return (
    <div
      style={{
        maxWidth: 720,
        margin: '0 auto',
        padding: '40px 20px 80px',
      }}
    >
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
        \u2190 Back to Learn
      </Link>

      {/* SAFETY: article.content is static markdown from lib/data/learn-articles.ts (not user input).
         renderMarkdown() is a simple markdown-to-HTML converter with no external content injection. */}
      <article
        dangerouslySetInnerHTML={{ __html: renderMarkdown(article.content) }}
      />
    </div>
  )
}
