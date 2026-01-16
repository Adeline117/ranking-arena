'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/Layout/TopNav'
import Card from '@/app/components/UI/Card'
import { Box, Text, Button } from '@/app/components/Base'
import { useLanguage } from '@/app/components/Utils/LanguageProvider'

type RoleNames = {
  admin: { zh: string; en: string }  // 管理员（包含组长和管理员）
  member: { zh: string; en: string }
}

export default function ApplyGroupPage() {
  const router = useRouter()
  const { t, language } = useLanguage()
  const [email, setEmail] = useState<string | null>(null)
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  // 表单状态
  const [primaryLang, setPrimaryLang] = useState<'zh' | 'en'>('zh')
  const [showMultiLang, setShowMultiLang] = useState(false)
  const [name, setName] = useState('')
  const [nameSecondary, setNameSecondary] = useState('')
  const [description, setDescription] = useState('')
  const [descriptionSecondary, setDescriptionSecondary] = useState('')
  const [avatarUrl, setAvatarUrl] = useState('')
  const [roleNames, setRoleNames] = useState<RoleNames>({
    admin: { zh: '管理员', en: '' },  // 管理员（包含组长和管理员）
    member: { zh: '成员', en: '' }
  })

  // 用户已有的申请
  const [existingApplications, setExistingApplications] = useState<any[]>([])

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setEmail(data.session?.user?.email ?? null)
      setAccessToken(data.session?.access_token ?? null)

      if (data.session?.access_token) {
        fetchMyApplications(data.session.access_token)
      }
    })
  }, [])

  const fetchMyApplications = async (token: string) => {
    try {
      const res = await fetch('/api/groups/apply', {
        headers: { Authorization: `Bearer ${token}` }
      })
      const data = await res.json()
      if (data.applications) {
        setExistingApplications(data.applications)
      }
    } catch (err) {
      console.error('Error fetching applications:', err)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    if (!accessToken) {
      setError(language === 'zh' ? '请先登录' : 'Please login first')
      return
    }

    if (!name.trim()) {
      setError(language === 'zh' ? '请填写小组名称' : 'Please enter group name')
      return
    }

    setLoading(true)
    setError(null)

    try {
      const res = await fetch('/api/groups/apply', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`
        },
        body: JSON.stringify({
          name: primaryLang === 'zh' ? name.trim() : (nameSecondary.trim() || name.trim()),
          name_en: primaryLang === 'en' ? name.trim() : (nameSecondary.trim() || null),
          description: primaryLang === 'zh' ? (description.trim() || null) : (descriptionSecondary.trim() || null),
          description_en: primaryLang === 'en' ? (description.trim() || null) : (descriptionSecondary.trim() || null),
          avatar_url: avatarUrl.trim() || null,
          role_names: roleNames
        })
      })

      const data = await res.json()

      if (!res.ok) {
        setError(data.error || (language === 'zh' ? '提交失败' : 'Submission failed'))
        return
      }

      setSuccess(true)
      // 刷新申请列表
      if (accessToken) {
        fetchMyApplications(accessToken)
      }
    } catch (err) {
      setError(language === 'zh' ? '网络错误' : 'Network error')
    } finally {
      setLoading(false)
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
    borderRadius: tokens.radius.lg,
    border: `1px solid ${tokens.colors.border.primary}`,
    background: tokens.colors.bg.primary,
    color: tokens.colors.text.primary,
    fontSize: tokens.typography.fontSize.base,
    outline: 'none',
    transition: `border-color ${tokens.transition.base}`,
  }

  const labelStyle: React.CSSProperties = {
    display: 'block',
    marginBottom: tokens.spacing[2],
    fontSize: tokens.typography.fontSize.sm,
    fontWeight: tokens.typography.fontWeight.semibold,
    color: tokens.colors.text.secondary,
  }

  const getStatusBadge = (status: string) => {
    const styles: Record<string, { bg: string; color: string; text: { zh: string; en: string } }> = {
      pending: { bg: '#FFF3CD', color: '#856404', text: { zh: '待审核', en: 'Pending' } },
      approved: { bg: '#D4EDDA', color: '#155724', text: { zh: '已通过', en: 'Approved' } },
      rejected: { bg: '#F8D7DA', color: '#721C24', text: { zh: '已拒绝', en: 'Rejected' } }
    }
    const style = styles[status] || styles.pending
    return (
      <Box
        as="span"
        style={{
          display: 'inline-block',
          padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
          borderRadius: tokens.radius.md,
          background: style.bg,
          color: style.color,
          fontSize: tokens.typography.fontSize.xs,
          fontWeight: tokens.typography.fontWeight.bold,
        }}
      >
        {style.text[language]}
      </Box>
    )
  }

  if (!accessToken) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box as="main" style={{ maxWidth: 600, margin: '0 auto', padding: tokens.spacing[6] }}>
          <Card title={language === 'zh' ? '申请创办小组' : 'Apply to Create Group'}>
            <Box style={{ textAlign: 'center', padding: tokens.spacing[8] }}>
              <Text size="lg" color="tertiary" style={{ marginBottom: tokens.spacing[4] }}>
                {language === 'zh' ? '请先登录后再申请创办小组' : 'Please login to apply for creating a group'}
              </Text>
              <Link href="/login?redirect=/groups/apply">
                <Button variant="primary">
                  {language === 'zh' ? '去登录' : 'Login'}
                </Button>
              </Link>
            </Box>
          </Card>
        </Box>
      </Box>
    )
  }

  if (success) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box as="main" style={{ maxWidth: 600, margin: '0 auto', padding: tokens.spacing[6] }}>
          <Card title={language === 'zh' ? '申请已提交' : 'Application Submitted'}>
            <Box style={{ textAlign: 'center', padding: tokens.spacing[8] }}>
              <Box style={{ 
                width: 64, 
                height: 64,
                borderRadius: '50%',
                background: 'rgba(139,111,168,0.2)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto',
                marginBottom: tokens.spacing[4],
              }}>
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#8b6fa8" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
              </Box>
              <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
                {language === 'zh' ? '申请已成功提交！' : 'Application submitted successfully!'}
              </Text>
              <Text color="tertiary" style={{ marginBottom: tokens.spacing[6] }}>
                {language === 'zh' 
                  ? '请等待管理员审核，审核结果将通过通知告知您。' 
                  : 'Please wait for admin review. You will be notified of the result.'}
              </Text>
              <Box style={{ display: 'flex', gap: tokens.spacing[3], justifyContent: 'center' }}>
                <Button variant="secondary" onClick={() => setSuccess(false)}>
                  {language === 'zh' ? '继续申请' : 'Apply Another'}
                </Button>
                <Link href="/groups">
                  <Button variant="primary">
                    {language === 'zh' ? '返回小组' : 'Back to Groups'}
                  </Button>
                </Link>
              </Box>
            </Box>
          </Card>
        </Box>
      </Box>
    )
  }

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />

      <Box as="main" style={{ maxWidth: 700, margin: '0 auto', padding: tokens.spacing[6] }}>
        {/* 返回链接 */}
        <Link
          href="/groups"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: tokens.spacing[2],
            color: tokens.colors.text.secondary,
            textDecoration: 'none',
            marginBottom: tokens.spacing[4],
            fontSize: tokens.typography.fontSize.sm,
          }}
        >
          ← {language === 'zh' ? '返回小组' : 'Back to Groups'}
        </Link>

        {/* 已有的申请 */}
        {existingApplications.length > 0 && (
          <Card title={language === 'zh' ? '我的申请' : 'My Applications'} style={{ marginBottom: tokens.spacing[6] }}>
            <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
              {existingApplications.map((app) => (
                <Box
                  key={app.id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: tokens.spacing[3],
                    background: tokens.colors.bg.secondary,
                    borderRadius: tokens.radius.lg,
                    border: `1px solid ${tokens.colors.border.primary}`,
                  }}
                >
                  <Box>
                    <Text weight="bold">{app.name}</Text>
                    <Text size="xs" color="tertiary">
                      {new Date(app.created_at).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US')}
                    </Text>
                  </Box>
                  {getStatusBadge(app.status)}
                </Box>
              ))}
            </Box>
          </Card>
        )}

        {/* 申请表单 */}
        <Card title={language === 'zh' ? '申请创办小组' : 'Apply to Create Group'}>
          <form onSubmit={handleSubmit}>
            <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[5] }}>
              {/* 语言选择 */}
              <Box>
                <label style={labelStyle}>
                  {language === 'zh' ? '小组语言' : 'Group Language'}
                </label>
                <Box style={{ display: 'flex', gap: tokens.spacing[2] }}>
                  <Button
                    type="button"
                    variant={primaryLang === 'zh' ? 'primary' : 'secondary'}
                    size="sm"
                    onClick={() => setPrimaryLang('zh')}
                  >
                    中文
                  </Button>
                  <Button
                    type="button"
                    variant={primaryLang === 'en' ? 'primary' : 'secondary'}
                    size="sm"
                    onClick={() => setPrimaryLang('en')}
                  >
                    English
                  </Button>
                </Box>
              </Box>

              {/* 小组名称 */}
              <Box>
                <label style={labelStyle}>
                  {language === 'zh' ? '小组名称 *' : 'Group Name *'}
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={primaryLang === 'zh' ? '例如：BTC 交易讨论组' : 'e.g., BTC Trading Discussion'}
                  style={inputStyle}
                  maxLength={50}
                  required
                />
              </Box>

              {/* 小组简介 */}
              <Box>
                <label style={labelStyle}>
                  {language === 'zh' ? '小组简介' : 'Group Description'}
                </label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={primaryLang === 'zh' ? '介绍一下你的小组...' : 'Describe your group...'}
                  style={{ ...inputStyle, minHeight: 100, resize: 'vertical' }}
                  maxLength={500}
                />
              </Box>

              {/* 多语言切换 */}
              {!showMultiLang ? (
                <Button
                  type="button"
                  variant="text"
                  size="sm"
                  onClick={() => setShowMultiLang(true)}
                  style={{ 
                    alignSelf: 'flex-start',
                    color: tokens.colors.accent?.primary || tokens.colors.text.secondary,
                    padding: 0,
                  }}
                >
                  + {language === 'zh' ? '添加多语言' : 'Add another language'}
                </Button>
              ) : (
                <Box style={{ 
                  padding: tokens.spacing[4], 
                  background: tokens.colors.bg.secondary, 
                  borderRadius: tokens.radius.lg,
                  border: `1px solid ${tokens.colors.border.primary}`,
                }}>
                  <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[3] }}>
                    <Text size="sm" weight="bold" color="secondary">
                      {primaryLang === 'zh' ? 'English Version' : '中文版本'}
                    </Text>
                    <Button
                      type="button"
                      variant="text"
                      size="sm"
                      onClick={() => {
                        setShowMultiLang(false)
                        setNameSecondary('')
                        setDescriptionSecondary('')
                      }}
                      style={{ padding: 0, color: tokens.colors.text.tertiary }}
                    >
                      {language === 'zh' ? '移除' : 'Remove'}
                    </Button>
                  </Box>

                  {/* 第二语言小组名称 */}
                  <Box style={{ marginBottom: tokens.spacing[3] }}>
                    <label style={labelStyle}>
                      {primaryLang === 'zh' ? 'Group Name (English)' : '小组名称（中文）'}
                    </label>
                    <input
                      type="text"
                      value={nameSecondary}
                      onChange={(e) => setNameSecondary(e.target.value)}
                      placeholder={primaryLang === 'zh' ? 'e.g., BTC Trading Discussion' : '例如：BTC 交易讨论组'}
                      style={inputStyle}
                      maxLength={50}
                    />
                  </Box>

                  {/* 第二语言小组简介 */}
                  <Box>
                    <label style={labelStyle}>
                      {primaryLang === 'zh' ? 'Group Description (English)' : '小组简介（中文）'}
                    </label>
                    <textarea
                      value={descriptionSecondary}
                      onChange={(e) => setDescriptionSecondary(e.target.value)}
                      placeholder={primaryLang === 'zh' ? 'Describe your group...' : '介绍一下你的小组...'}
                      style={{ ...inputStyle, minHeight: 80, resize: 'vertical' }}
                      maxLength={500}
                    />
                  </Box>
                </Box>
              )}

              {/* 小组头像 URL */}
              <Box>
                <label style={labelStyle}>
                  {language === 'zh' ? '小组头像 URL' : 'Group Avatar URL'}
                </label>
                <input
                  type="url"
                  value={avatarUrl}
                  onChange={(e) => setAvatarUrl(e.target.value)}
                  placeholder="https://example.com/avatar.png"
                  style={inputStyle}
                />
                {avatarUrl && (
                  <Box style={{ marginTop: tokens.spacing[2] }}>
                    <img
                      src={avatarUrl}
                      alt="Preview"
                      style={{
                        width: 60,
                        height: 60,
                        borderRadius: tokens.radius.lg,
                        objectFit: 'cover',
                        border: `1px solid ${tokens.colors.border.primary}`,
                      }}
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = 'none'
                      }}
                    />
                  </Box>
                )}
              </Box>

              {/* 角色称呼设置 */}
              <Box>
                <Text weight="bold" style={{ marginBottom: tokens.spacing[3] }}>
                  {language === 'zh' ? '角色称呼设置' : 'Role Names'}
                </Text>
                <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[3] }}>
                  {language === 'zh' 
                    ? '自定义小组内角色的称呼（可选，中英文至少填一种）' 
                    : 'Customize role names for your group (optional, fill at least one language)'}
                </Text>

                <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
                  {/* 管理员（包含组长和管理员） */}
                  <Box style={{ display: 'grid', gridTemplateColumns: '100px 1fr 1fr', gap: tokens.spacing[2], alignItems: 'center' }}>
                    <Text size="sm" color="secondary">
                      {language === 'zh' ? '组长/管理员' : 'Admin'}
                    </Text>
                    <input
                      type="text"
                      value={roleNames.admin.zh}
                      onChange={(e) => setRoleNames({ ...roleNames, admin: { ...roleNames.admin, zh: e.target.value } })}
                      placeholder="中文（如：掌门）"
                      style={{ ...inputStyle, padding: tokens.spacing[2] }}
                      maxLength={20}
                    />
                    <input
                      type="text"
                      value={roleNames.admin.en}
                      onChange={(e) => setRoleNames({ ...roleNames, admin: { ...roleNames.admin, en: e.target.value } })}
                      placeholder="English (e.g., Leader)"
                      style={{ ...inputStyle, padding: tokens.spacing[2] }}
                      maxLength={20}
                    />
                  </Box>

                  {/* 成员 */}
                  <Box style={{ display: 'grid', gridTemplateColumns: '100px 1fr 1fr', gap: tokens.spacing[2], alignItems: 'center' }}>
                    <Text size="sm" color="secondary">
                      {language === 'zh' ? '成员' : 'Member'}
                    </Text>
                    <input
                      type="text"
                      value={roleNames.member.zh}
                      onChange={(e) => setRoleNames({ ...roleNames, member: { ...roleNames.member, zh: e.target.value } })}
                      placeholder="中文（如：弟子）"
                      style={{ ...inputStyle, padding: tokens.spacing[2] }}
                      maxLength={20}
                    />
                    <input
                      type="text"
                      value={roleNames.member.en}
                      onChange={(e) => setRoleNames({ ...roleNames, member: { ...roleNames.member, en: e.target.value } })}
                      placeholder="English (e.g., Disciple)"
                      style={{ ...inputStyle, padding: tokens.spacing[2] }}
                      maxLength={20}
                    />
                  </Box>
                </Box>
              </Box>

              {/* 错误信息 */}
              {error && (
                <Box
                  style={{
                    padding: tokens.spacing[3],
                    background: '#FEE2E2',
                    borderRadius: tokens.radius.lg,
                    border: '1px solid #FECACA',
                  }}
                >
                  <Text size="sm" style={{ color: '#DC2626' }}>
                    {error}
                  </Text>
                </Box>
              )}

              {/* 提交按钮 */}
              <Box style={{ display: 'flex', gap: tokens.spacing[3], justifyContent: 'flex-end' }}>
                <Link href="/groups">
                  <Button variant="secondary" type="button">
                    {language === 'zh' ? '取消' : 'Cancel'}
                  </Button>
                </Link>
                <Button variant="primary" type="submit" disabled={loading}>
                  {loading 
                    ? (language === 'zh' ? '提交中...' : 'Submitting...') 
                    : (language === 'zh' ? '提交申请' : 'Submit Application')}
                </Button>
              </Box>
            </Box>
          </form>
        </Card>
      </Box>
    </Box>
  )
}

