/**
 * JSON-LD 结构化数据组件
 * 用于在页面中插入 Schema.org 结构化数据
 */

interface JsonLdProps {
  data: object | object[]
}

/**
 * JSON-LD Script 组件
 * 
 * @example
 * ```tsx
 * import { JsonLd } from '@/app/components/utils/JsonLd'
 * import { generateWebSiteSchema } from '@/lib/seo'
 * 
 * export default function HomePage() {
 *   return (
 *     <>
 *       <JsonLd data={generateWebSiteSchema()} />
 *       <main>...</main>
 *     </>
 *   )
 * }
 * ```
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
