export type LibraryItem = {
  id: string
  title: string
  title_zh?: string | null
  title_en?: string | null
  author: string | null
  description: string | null
  category: string
  subcategory: string | null
  source: string | null
  source_url: string | null
  pdf_url: string | null
  cover_url: string | null
  tags: string[] | null
  crypto_symbols: string[] | null
  publish_date: string | null
  view_count: number
  download_count: number
  is_free: boolean
  buy_url: string | null
  language?: string | null
  language_group_id?: string | null
  isbn?: string | null
  pages?: number | null
  page_count?: number | null
  publisher?: string | null
  rating?: number | null
  rating_count?: number | null
  created_at?: string | null
}
