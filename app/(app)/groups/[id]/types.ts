export interface Group {
  id: string
  name: string
  name_en?: string | null
  description?: string | null
  description_en?: string | null
  avatar_url?: string | null
  member_count?: number | null
  created_at?: string | null
  created_by?: string | null
  rules?: string | null
  rules_json?: Array<{ zh: string; en: string }> | null
  owner_handle?: string | null
  is_premium_only?: boolean | null
}

export interface GroupMember {
  user_id: string
  role: string
  handle?: string | null
  avatar_url?: string | null
  joined_at?: string | null
}

/** Inline bilingual text helper (for one-off strings not in the i18n dictionary) */
export function bilingualText(zh: string, en: string, language: string): string {
  return language === 'zh' ? zh : en
}

export function isChineseText(text: string): boolean {
  if (!text) return false
  const chineseMatches = text.match(/[\u4e00-\u9fa5]/g)
  const chineseRatio = chineseMatches ? chineseMatches.length / text.length : 0
  return chineseRatio > 0.1
}
