interface JsonLdProps {
  data: object
}

/**
 * Safely serialize JSON-LD data, escaping sequences that could break
 * out of a <script> tag (e.g. "</script>" in user-generated content).
 */
function safeJsonLd(data: object): string {
  return JSON.stringify(data).replace(/</g, '\\u003c')
}

/**
 * Inline JSON-LD structured data.
 * Uses a plain <script> tag instead of next/script to avoid client-side JS overhead.
 * JSON-LD does not need hydration or deferred loading.
 */
export function JsonLd({ data }: JsonLdProps) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: safeJsonLd(data) }}
    />
  )
}

export default JsonLd
