/**
 * GDPR 数据保护合规实现
 * 提供用户数据导出和删除功能
 */

import { SupabaseClient } from '@supabase/supabase-js'

// ============================================
// 类型定义
// ============================================

export interface UserDataExport {
  exportedAt: string
  user: {
    id: string
    email: string
    created_at: string
  }
  profile: {
    handle: string | null
    display_name: string | null
    bio: string | null
    avatar_url: string | null
  } | null
  subscription: {
    tier: string
    status: string
    expires_at: string | null
  } | null
  reviews: Array<{
    id: string
    trader_id: string
    source: string
    overall_rating: number
    review_text: string | null
    created_at: string
  }>
  favorites: Array<{
    trader_id: string
    source: string
    added_at: string
  }>
  alertConfigs: Array<{
    trader_id: string
    source: string
    drawdown_threshold: number
    created_at: string
  }>
  alerts: Array<{
    id: string
    type: string
    title: string
    created_at: string
  }>
  followJournals: Array<{
    id: string
    trader_id: string
    source: string
    title: string | null
    content: string
    created_at: string
  }>
  avoidVotes: Array<{
    trader_id: string
    source: string
    reason: string | null
    created_at: string
  }>
  inviteCodes: Array<{
    code: string
    current_uses: number
    created_at: string
  }>
}

export interface DataDeletionResult {
  success: boolean
  deletedAt: string
  deletedItems: {
    reviews: number
    favorites: number
    alertConfigs: number
    alerts: number
    followJournals: number
    avoidVotes: number
    inviteCodes: number
    profile: boolean
    subscription: boolean
  }
  errors: string[]
}

// ============================================
// 用户数据导出（GDPR 第 20 条 - 数据可携性权）
// ============================================

export async function exportUserData(
  supabase: SupabaseClient,
  userId: string
): Promise<UserDataExport> {
  const exportData: UserDataExport = {
    exportedAt: new Date().toISOString(),
    user: { id: userId, email: '', created_at: '' },
    profile: null,
    subscription: null,
    reviews: [],
    favorites: [],
    alertConfigs: [],
    alerts: [],
    followJournals: [],
    avoidVotes: [],
    inviteCodes: [],
  }

  // 1. 获取基本用户信息
  const { data: userData } = await supabase.auth.admin.getUserById(userId)
  if (userData?.user) {
    exportData.user = {
      id: userData.user.id,
      email: userData.user.email || '',
      created_at: userData.user.created_at || '',
    }
  }

  // 2. 获取用户资料
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('handle, display_name, bio, avatar_url')
    .eq('user_id', userId)
    .maybeSingle()
  
  exportData.profile = profile

  // 3. 获取订阅信息
  const { data: subscription } = await supabase
    .from('user_subscriptions')
    .select('tier, status, current_period_end')
    .eq('user_id', userId)
    .maybeSingle()
  
  if (subscription) {
    exportData.subscription = {
      tier: subscription.tier,
      status: subscription.status,
      expires_at: subscription.current_period_end,
    }
  }

  // 4. 获取评价
  const { data: reviews } = await supabase
    .from('trader_reviews')
    .select('id, trader_id, source, overall_rating, review_text, created_at')
    .eq('user_id', userId)
  
  exportData.reviews = reviews || []

  // 5. 获取收藏
  const { data: favorites } = await supabase
    .from('user_favorites')
    .select('trader_id, source, created_at')
    .eq('user_id', userId)
  
  exportData.favorites = (favorites || []).map(f => ({
    trader_id: f.trader_id,
    source: f.source,
    added_at: f.created_at,
  }))

  // 6. 获取告警配置
  const { data: alertConfigs } = await supabase
    .from('user_alert_configs')
    .select('trader_id, source, drawdown_threshold, created_at')
    .eq('user_id', userId)
  
  exportData.alertConfigs = alertConfigs || []

  // 7. 获取告警历史
  const { data: alerts } = await supabase
    .from('trader_alerts')
    .select('id, type, title, created_at')
    .eq('user_id', userId)
    .limit(1000)  // 限制数量
  
  exportData.alerts = alerts || []

  // 8. 获取跟单日记
  const { data: journals } = await supabase
    .from('follow_journals')
    .select('id, trader_id, source, title, content, created_at')
    .eq('user_id', userId)
  
  exportData.followJournals = journals || []

  // 9. 获取避雷投票
  const { data: avoidVotes } = await supabase
    .from('avoid_votes')
    .select('trader_id, source, reason, created_at')
    .eq('user_id', userId)
  
  exportData.avoidVotes = avoidVotes || []

  // 10. 获取邀请码
  const { data: inviteCodes } = await supabase
    .from('invite_codes')
    .select('code, current_uses, created_at')
    .eq('creator_id', userId)
  
  exportData.inviteCodes = inviteCodes || []

  return exportData
}

// ============================================
// 用户数据删除（GDPR 第 17 条 - 被遗忘权）
// ============================================

export async function deleteUserData(
  supabase: SupabaseClient,
  userId: string,
  options: {
    /** 是否保留匿名化的评价 */
    keepAnonymizedReviews?: boolean
    /** 删除原因（用于审计） */
    reason?: string
  } = {}
): Promise<DataDeletionResult> {
  const { keepAnonymizedReviews = false, reason = 'user_request' } = options
  
  const result: DataDeletionResult = {
    success: false,
    deletedAt: new Date().toISOString(),
    deletedItems: {
      reviews: 0,
      favorites: 0,
      alertConfigs: 0,
      alerts: 0,
      followJournals: 0,
      avoidVotes: 0,
      inviteCodes: 0,
      profile: false,
      subscription: false,
    },
    errors: [],
  }

  try {
    // 1. 记录删除请求（用于审计）
    await supabase.from('data_deletion_logs').insert({
      user_id: userId,
      reason,
      requested_at: new Date().toISOString(),
    })

    // 2. 删除评价（或匿名化）
    if (keepAnonymizedReviews) {
      // 匿名化：将 user_id 设为 null，移除个人信息
      const { data: reviews } = await supabase
        .from('trader_reviews')
        .update({ 
          user_id: null,
          author_handle: '[已删除用户]',
          author_avatar_url: null,
        })
        .eq('user_id', userId)
        .select('id')
      
      result.deletedItems.reviews = reviews?.length || 0
    } else {
      const { data: reviews } = await supabase
        .from('trader_reviews')
        .delete()
        .eq('user_id', userId)
        .select('id')
      
      result.deletedItems.reviews = reviews?.length || 0
    }

    // 3. 删除收藏
    const { data: favorites } = await supabase
      .from('user_favorites')
      .delete()
      .eq('user_id', userId)
      .select('id')
    
    result.deletedItems.favorites = favorites?.length || 0

    // 4. 删除告警配置
    const { data: alertConfigs } = await supabase
      .from('user_alert_configs')
      .delete()
      .eq('user_id', userId)
      .select('id')
    
    result.deletedItems.alertConfigs = alertConfigs?.length || 0

    // 5. 删除告警历史
    const { data: alerts } = await supabase
      .from('trader_alerts')
      .delete()
      .eq('user_id', userId)
      .select('id')
    
    result.deletedItems.alerts = alerts?.length || 0

    // 6. 删除跟单日记
    const { data: journals } = await supabase
      .from('follow_journals')
      .delete()
      .eq('user_id', userId)
      .select('id')
    
    result.deletedItems.followJournals = journals?.length || 0

    // 7. 删除避雷投票
    const { data: avoidVotes } = await supabase
      .from('avoid_votes')
      .delete()
      .eq('user_id', userId)
      .select('id')
    
    result.deletedItems.avoidVotes = avoidVotes?.length || 0

    // 8. 停用邀请码
    const { data: inviteCodes } = await supabase
      .from('invite_codes')
      .update({ is_active: false })
      .eq('creator_id', userId)
      .select('id')
    
    result.deletedItems.inviteCodes = inviteCodes?.length || 0

    // 9. 删除用户资料
    const { error: profileError } = await supabase
      .from('user_profiles')
      .delete()
      .eq('user_id', userId)
    
    result.deletedItems.profile = !profileError

    // 10. 取消订阅
    const { error: subError } = await supabase
      .from('user_subscriptions')
      .update({ 
        status: 'cancelled',
        cancelled_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
    
    result.deletedItems.subscription = !subError

    // 11. 更新删除日志
    await supabase
      .from('data_deletion_logs')
      .update({
        completed_at: new Date().toISOString(),
        deleted_items: result.deletedItems,
      })
      .eq('user_id', userId)
      .order('requested_at', { ascending: false })
      .limit(1)

    result.success = true
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : 'Unknown error')
  }

  return result
}

// ============================================
// 数据删除日志表 SQL（需要先创建）
// ============================================

export const CREATE_DELETION_LOG_TABLE = `
CREATE TABLE IF NOT EXISTS data_deletion_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  reason TEXT,
  requested_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  deleted_items JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deletion_logs_user ON data_deletion_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_deletion_logs_requested ON data_deletion_logs(requested_at);
`

// ============================================
// Cookie 同意管理
// ============================================

export interface CookieConsent {
  necessary: boolean  // 必要 Cookie（总是 true）
  analytics: boolean  // 分析 Cookie
  marketing: boolean  // 营销 Cookie
  preferences: boolean // 偏好 Cookie
  consentedAt: string
  version: string
}

const CONSENT_VERSION = '1.0'

export function getDefaultCookieConsent(): CookieConsent {
  return {
    necessary: true,
    analytics: false,
    marketing: false,
    preferences: false,
    consentedAt: '',
    version: CONSENT_VERSION,
  }
}

export function saveCookieConsent(consent: Omit<CookieConsent, 'consentedAt' | 'version'>): void {
  const fullConsent: CookieConsent = {
    ...consent,
    necessary: true, // Always required
    consentedAt: new Date().toISOString(),
    version: CONSENT_VERSION,
  }
  
  if (typeof window !== 'undefined') {
    localStorage.setItem('cookie_consent', JSON.stringify(fullConsent))
    
    // Trigger consent change event
    window.dispatchEvent(new CustomEvent('cookie-consent-change', { detail: fullConsent }))
  }
}

export function getCookieConsent(): CookieConsent | null {
  if (typeof window === 'undefined') return null
  
  const stored = localStorage.getItem('cookie_consent')
  if (!stored) return null
  
  try {
    const consent = JSON.parse(stored) as CookieConsent
    
    // Check if consent version is outdated
    if (consent.version !== CONSENT_VERSION) {
      return null
    }
    
    return consent
  } catch {
    return null
  }
}

export function hasCookieConsent(type: keyof Omit<CookieConsent, 'consentedAt' | 'version'>): boolean {
  const consent = getCookieConsent()
  if (!consent) return type === 'necessary'
  return consent[type]
}
