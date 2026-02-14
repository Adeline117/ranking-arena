interface JsonLdProps {
  data: object
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
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  )
}

export default JsonLd
