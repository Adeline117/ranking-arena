'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import Card from '@/app/components/ui/Card'
import { Box, Text, Button } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useSubscription } from '@/app/components/home/hooks/useSubscription'
import { useToast } from '@/app/components/ui/Toast'
import { getCsrfHeaders } from '@/lib/api/client'
import { useAuthSession } from '@/lib/hooks/useAuthSession'

type RoleNames = {
  admin: { zh: string; en: string }
  member: { zh: string; en: string }
}

type Rule = {
  zh: string
  en: string
}

export default function ApplyGroupPage() {
  const _router = useRouter()
  const { t: _t, language } = useLanguage()
  const { isPro } = useSubscription()
  const { showToast } = useToast()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { accessToken, email, userId } = useAuthSession()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  // 当前编辑的语言标签
  const [activeTab, setActiveTab] = useState<'zh' | 'en'>('zh')
  // 是否显示多语言（英文）
  const [showMultiLang, setShowMultiLang] = useState(false)

  // 表单状态 - 中文
  const [nameZh, setNameZh] = useState('')
  const [descriptionZh, setDescriptionZh] = useState('')
  
  // 表单状态 - 英文
  const [nameEn, setNameEn] = useState('')
  const [descriptionEn, setDescriptionEn] = useState('')
  
  // 小组规则（支持多条，中英文）
  const [rules, setRules] = useState<Rule[]>([])
  const [newRuleZh, setNewRuleZh] = useState('')
  const [newRuleEn, setNewRuleEn] = useState('')

  // 头像和角色称呼
  const [avatarUrl, setAvatarUrl] = useState('')
  const [roleNames, setRoleNames] = useState<RoleNames>({
    admin: { zh: '管理员', en: 'Admin' },
    member: { zh: '成员', en: 'Member' }
  })
  
  // Pro 专属小组选项
  const [isPremiumOnly, setIsPremiumOnly] = useState(false)

  // 用户已有的申请
  const [existingApplications, setExistingApplications] = useState<any[]>([])

  useEffect(() => {
    if (accessToken) {
      fetchMyApplications(accessToken)
    }
  }, [accessToken])

  // Field-level validation
  const validateField = (fieldName: string, _value: string) => {
    const newErrors = { ...fieldErrors }

    if (fieldName === 'nameZh' || fieldName === 'nameEn') {
      // At least one name (Chinese or English) is required
      if (!nameZh.trim() && !nameEn.trim()) {
        newErrors['name'] = language === 'zh'
          ? '请至少填写一个小组名称（中文或英文）'
          : 'Please enter at least one group name (Chinese or English)'
      } else {
        delete newErrors['name']
      }
    }

    setFieldErrors(newErrors)
  }

  const fetchMyApplications = async (token: string) => {
    try {
      const res = await fetch('/api/groups/apply', {
        headers: { Authorization: `Bearer ${token}` }
      })
      
      if (!res.ok) {
        console.warn('Failed to fetch applications:', res.status)
        return
      }
      
      const data = await res.json()
      if (data.applications) {
        setExistingApplications(data.applications)
      }
    } catch (err) {
      console.error('Error fetching applications:', err)
      // 静默失败，不影响用户操作
    }
  }

  // 添加规则
  const addRule = () => {
    const zhText = newRuleZh.trim()
    const enText = newRuleEn.trim()
    
    if (!zhText && !enText) return
    
    setRules([...rules, { zh: zhText, en: enText }])
    setNewRuleZh('')
    setNewRuleEn('')
  }

  // 删除规则
  const removeRule = (index: number) => {
    setRules(rules.filter((_, i) => i !== index))
  }

  // 编辑规则
  const updateRule = (index: number, lang: 'zh' | 'en', value: string) => {
    const newRules = [...rules]
    newRules[index] = { ...newRules[index], [lang]: value }
    setRules(newRules)
  }

  // 处理图片上传
  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return

    if (!userId) {
      showToast(language === 'zh' ? '请先登录' : 'Please login first', 'warning')
      return
    }

    const file = files[0] // 头像只支持单张图片
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']
    if (!allowedTypes.includes(file.type)) {
      showToast(language === 'zh' ? '不支持的图片格式，仅支持 jpg, png, gif, webp' : 'Unsupported image format. Only jpg, png, gif, webp are allowed', 'error')
      return
    }

    if (file.size > 5 * 1024 * 1024) {
      showToast(language === 'zh' ? '图片大小不能超过 5MB' : 'Image size cannot exceed 5MB', 'error')
      return
    }

    setUploading(true)

    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('userId', userId)

      const response = await fetch('/api/posts/upload-image', {
        method: 'POST',
        body: formData,
      })

      if (!response.ok) {
        let errorMsg = language === 'zh' ? '上传失败' : 'Upload failed'
        try {
          const errorData = await response.json()
          errorMsg = errorData.error || errorMsg
        } catch {
          errorMsg = `${errorMsg} (${response.status})`
        }
        showToast(errorMsg, 'error')
        return
      }

      const data = await response.json()
      setAvatarUrl(data.url)
      showToast(language === 'zh' ? '图片上传成功' : 'Image uploaded successfully', 'success')
    } catch (error: unknown) {
      console.error('Upload error:', error)
      const errorMsg = error instanceof Error ? error.message : (language === 'zh' ? '网络错误，请稍后重试' : 'Network error, please try again later')
      showToast(errorMsg, 'error')
    } finally {
      setUploading(false)
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!accessToken) {
      setError(language === 'zh' ? '请先登录' : 'Please login first')
      return
    }

    // Validate all fields before submitting
    const newErrors: Record<string, string> = {}

    // At least one name is required
    if (!nameZh.trim() && !nameEn.trim()) {
      newErrors['name'] = language === 'zh'
        ? '请至少填写一个小组名称（中文或英文）'
        : 'Please enter at least one group name (Chinese or English)'
    }

    if (Object.keys(newErrors).length > 0) {
      setFieldErrors(newErrors)
      setError(language === 'zh' ? '请修正表单错误' : 'Please fix the form errors')
      return
    }

    setLoading(true)
    setError(null)
    setFieldErrors({})

    try {
      const res = await fetch('/api/groups/apply', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          ...getCsrfHeaders()
        },
        body: JSON.stringify({
          name: nameZh.trim() || nameEn.trim(),
          name_en: nameEn.trim() || null,
          description: descriptionZh.trim() || null,
          description_en: descriptionEn.trim() || null,
          avatar_url: avatarUrl.trim() || null,
          role_names: roleNames,
          rules_json: rules.length > 0 ? rules : null,
          // 兼容旧版：将规则合并为文本（仅中文，英文通过rules_json获取）
          rules: rules.map(r => r.zh).filter(Boolean).join('\n') || null,
          // Pro 专属小组选项
          is_premium_only: isPro && isPremiumOnly,
        })
      })

      // 检查响应状态
      if (!res.ok) {
        let errorMessage = language === 'zh' ? '提交失败' : 'Submission failed'
        
        try {
          const data = await res.json()
          // 使用API返回的错误信息
          if (data.error) {
            errorMessage = data.error
          } else if (data.message) {
            errorMessage = data.message
          }
        } catch (_parseError) {
          // 如果JSON解析失败，尝试获取状态文本
          if (res.status === 401) {
            errorMessage = language === 'zh' ? '身份验证失败，请重新登录' : 'Authentication failed, please login again'
          } else if (res.status === 403) {
            errorMessage = language === 'zh' ? '没有权限执行此操作' : 'Permission denied'
          } else if (res.status === 400) {
            errorMessage = language === 'zh' ? '请求参数错误' : 'Invalid request parameters'
          } else if (res.status === 500) {
            errorMessage = language === 'zh' ? '服务器错误，请稍后重试' : 'Server error, please try again later'
          }
        }
        
        setError(errorMessage)
        return
      }

      const _data = await res.json()

      setSuccess(true)
      if (accessToken) {
        fetchMyApplications(accessToken)
      }
    } catch (err) {
      // 处理网络错误和其他异常
      console.error('Submit error:', err)
      let errorMessage = language === 'zh' ? '网络错误，请检查网络连接' : 'Network error, please check your connection'
      
      if (err instanceof TypeError && err.message.includes('fetch')) {
        errorMessage = language === 'zh' ? '无法连接到服务器，请检查网络连接' : 'Unable to connect to server, please check your connection'
      }
      
      setError(errorMessage)
    } finally {
      setLoading(false)
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
    borderRadius: tokens.radius.lg,
    border: ('1px solid ' + tokens.colors.border.primary),
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

  const tabStyle = (isActive: boolean): React.CSSProperties => ({
    padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
    borderRadius: `${tokens.radius.lg} ${tokens.radius.lg} 0 0`,
    border: ('1px solid ' + isActive ? tokens.colors.border.primary : 'transparent'),
    borderBottom: isActive ? 'none' : ('1px solid ' + tokens.colors.border.primary),
    background: isActive ? tokens.colors.bg.secondary : 'transparent',
    color: isActive ? tokens.colors.text.primary : tokens.colors.text.tertiary,
    cursor: 'pointer',
    fontWeight: isActive ? tokens.typography.fontWeight.bold : tokens.typography.fontWeight.medium,
    transition: `all ${tokens.transition.base}`,
  })

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
          <Card title={language === 'zh' ? '小组已创建' : 'Group Created'}>
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
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.accent.brand} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
              </Box>
              <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
                {language === 'zh' ? '小组创建成功！' : 'Group created successfully!'}
              </Text>
              <Text color="tertiary" style={{ marginBottom: tokens.spacing[6] }}>
                {language === 'zh' 
                  ? '你的小组已创建，现在可以开始邀请成员加入。' 
                  : 'Your group is live! Start inviting members to join.'}
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
                    border: ('1px solid ' + tokens.colors.border.primary),
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
              
              {/* 语言标签页 */}
              <Box>
                <Box style={{ display: 'flex', borderBottom: ('1px solid ' + tokens.colors.border.primary) }}>
                  <button
                    type="button"
                    style={tabStyle(activeTab === 'zh')}
                    onClick={() => setActiveTab('zh')}
                  >
                    中文
                  </button>
                  {showMultiLang && (
                    <button
                      type="button"
                      style={tabStyle(activeTab === 'en')}
                      onClick={() => setActiveTab('en')}
                    >
                      English
                    </button>
                  )}
                  {!showMultiLang && (
                    <button
                      type="button"
                      style={{
                        ...tabStyle(false),
                        color: tokens.colors.accent?.primary || tokens.colors.accent.brand,
                        border: 'none',
                      }}
                      onClick={() => {
                        setShowMultiLang(true)
                        setActiveTab('en')
                      }}
                    >
                      + {language === 'zh' ? '添加多语言' : 'Add Language'}
                    </button>
                  )}
                </Box>

                {/* 中文表单 */}
                <Box 
                  style={{ 
                    display: activeTab === 'zh' ? 'flex' : 'none',
                    flexDirection: 'column',
                    gap: tokens.spacing[4],
                    padding: tokens.spacing[4],
                    background: tokens.colors.bg.secondary,
                    borderRadius: ('0 0 ' + tokens.radius.lg + ' ' + tokens.radius.lg),
                    border: ('1px solid ' + tokens.colors.border.primary),
                    borderTop: 'none',
                  }}
                >
                  {/* 小组名称（中文） */}
                  <Box>
                    <label style={labelStyle}>
                      小组名称 *
                    </label>
                    <input
                      type="text"
                      value={nameZh}
                      onChange={(e) => setNameZh(e.target.value)}
                      onBlur={() => validateField('nameZh', nameZh)}
                      placeholder="例如：BTC 交易讨论组"
                      style={{
                        ...inputStyle,
                        borderColor: fieldErrors.name ? tokens.colors.accent.error : tokens.colors.border.primary
                      }}
                      aria-invalid={!!fieldErrors.name}
                      maxLength={50}
                    />
                    {fieldErrors.name && (
                      <Text size="xs" style={{ color: tokens.colors.accent.error, marginTop: tokens.spacing[1] }}>
                        {fieldErrors.name}
                      </Text>
                    )}
                  </Box>

                  {/* 小组简介（中文） */}
                  <Box>
                    <label style={labelStyle}>
                      小组简介
                    </label>
                    <textarea
                      value={descriptionZh}
                      onChange={(e) => setDescriptionZh(e.target.value)}
                      placeholder="介绍一下你的小组..."
                      style={{ ...inputStyle, minHeight: 100, resize: 'vertical' }}
                      maxLength={500}
                    />
                  </Box>
                </Box>

                {/* 英文表单 */}
                {showMultiLang && (
                  <Box 
                    style={{ 
                      display: activeTab === 'en' ? 'flex' : 'none',
                      flexDirection: 'column',
                      gap: tokens.spacing[4],
                      padding: tokens.spacing[4],
                      background: tokens.colors.bg.secondary,
                      borderRadius: ('0 0 ' + tokens.radius.lg + ' ' + tokens.radius.lg),
                      border: ('1px solid ' + tokens.colors.border.primary),
                      borderTop: 'none',
                    }}
                  >
                    <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Text size="sm" color="tertiary">English Version</Text>
                      <Button
                        type="button"
                        variant="text"
                        size="sm"
                        onClick={() => {
                          setShowMultiLang(false)
                          setActiveTab('zh')
                          setNameEn('')
                          setDescriptionEn('')
                        }}
                        style={{ padding: 0, color: tokens.colors.text.tertiary }}
                      >
                        {language === 'zh' ? '移除英文' : 'Remove English'}
                      </Button>
                    </Box>

                    {/* 小组名称（英文） */}
                    <Box>
                      <label style={labelStyle}>
                        Group Name
                      </label>
                      <input
                        type="text"
                        value={nameEn}
                        onChange={(e) => setNameEn(e.target.value)}
                        onBlur={() => validateField('nameEn', nameEn)}
                        placeholder="e.g., BTC Trading Discussion"
                        style={{
                          ...inputStyle,
                          borderColor: fieldErrors.name ? tokens.colors.accent.error : tokens.colors.border.primary
                        }}
                        aria-invalid={!!fieldErrors.name}
                        maxLength={50}
                      />
                      {fieldErrors.name && (
                        <Text size="xs" style={{ color: tokens.colors.accent.error, marginTop: tokens.spacing[1] }}>
                          {fieldErrors.name}
                        </Text>
                      )}
                    </Box>

                    {/* 小组简介（英文） */}
                    <Box>
                      <label style={labelStyle}>
                        Group Description
                      </label>
                      <textarea
                        value={descriptionEn}
                        onChange={(e) => setDescriptionEn(e.target.value)}
                        placeholder="Describe your group..."
                        style={{ ...inputStyle, minHeight: 100, resize: 'vertical' }}
                        maxLength={500}
                      />
                    </Box>
                  </Box>
                )}
              </Box>

              {/* 小组规则 */}
              <Box>
                <Text weight="bold" style={{ marginBottom: tokens.spacing[3] }}>
                  {language === 'zh' ? '小组规则' : 'Group Rules'}
                </Text>
                <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[3] }}>
                  {language === 'zh' 
                    ? '一条一条添加小组规则，成员需要遵守这些规则' 
                    : 'Add rules one by one that members must follow'}
                </Text>

                {/* 已添加的规则列表 */}
                {rules.length > 0 && (
                  <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2], marginBottom: tokens.spacing[3] }}>
                    {rules.map((rule, index) => (
                      <Box
                        key={index}
                        style={{
                          padding: tokens.spacing[3],
                          background: tokens.colors.bg.secondary,
                          borderRadius: tokens.radius.lg,
                          border: ('1px solid ' + tokens.colors.border.primary),
                        }}
                      >
                        <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: tokens.spacing[2] }}>
                          <Text size="sm" weight="bold" color="secondary">
                            {language === 'zh' ? `规则 ${index + 1}` : `Rule ${index + 1}`}
                          </Text>
                          <Button
                            type="button"
                            variant="text"
                            size="sm"
                            onClick={() => removeRule(index)}
                            style={{ padding: 0, color: '#ff6b6b', fontSize: tokens.typography.fontSize.xs }}
                          >
                            {language === 'zh' ? '删除' : 'Delete'}
                          </Button>
                        </Box>
                        
                        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
                          <Box>
                            <Text size="xs" color="tertiary" style={{ marginBottom: 4 }}>中文</Text>
                            <input
                              type="text"
                              value={rule.zh}
                              onChange={(e) => updateRule(index, 'zh', e.target.value)}
                              style={{ ...inputStyle, padding: tokens.spacing[2], fontSize: tokens.typography.fontSize.sm }}
                              placeholder="规则内容（中文）"
                            />
                          </Box>
                          {showMultiLang && (
                            <Box>
                              <Text size="xs" color="tertiary" style={{ marginBottom: 4 }}>English</Text>
                              <input
                                type="text"
                                value={rule.en}
                                onChange={(e) => updateRule(index, 'en', e.target.value)}
                                style={{ ...inputStyle, padding: tokens.spacing[2], fontSize: tokens.typography.fontSize.sm }}
                                placeholder="Rule content (English)"
                              />
                            </Box>
                          )}
                        </Box>
                      </Box>
                    ))}
                  </Box>
                )}

                {/* 添加新规则 */}
                <Box
                  style={{
                    padding: tokens.spacing[3],
                    background: tokens.colors.bg.secondary,
                    borderRadius: tokens.radius.lg,
                    border: ('1px dashed ' + tokens.colors.border.primary),
                  }}
                >
                  <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[2] }}>
                    {language === 'zh' ? '添加新规则' : 'Add New Rule'}
                  </Text>
                  <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
                    <input
                      type="text"
                      value={newRuleZh}
                      onChange={(e) => setNewRuleZh(e.target.value)}
                      style={{ ...inputStyle, padding: tokens.spacing[2], fontSize: tokens.typography.fontSize.sm }}
                      placeholder={language === 'zh' ? '输入规则内容（中文）' : 'Enter rule (Chinese)'}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          addRule()
                        }
                      }}
                    />
                    {showMultiLang && (
                      <input
                        type="text"
                        value={newRuleEn}
                        onChange={(e) => setNewRuleEn(e.target.value)}
                        style={{ ...inputStyle, padding: tokens.spacing[2], fontSize: tokens.typography.fontSize.sm }}
                        placeholder="Enter rule (English)"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            addRule()
                          }
                        }}
                      />
                    )}
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={addRule}
                      disabled={!newRuleZh.trim() && !newRuleEn.trim()}
                      style={{ alignSelf: 'flex-start' }}
                    >
                      + {language === 'zh' ? '添加规则' : 'Add Rule'}
                    </Button>
                  </Box>
                </Box>
              </Box>

              {/* 小组头像 */}
              <Box>
                <label style={labelStyle}>
                  {language === 'zh' ? '小组头像' : 'Group Avatar'}
                </label>
                <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[2] }}>
                  {language === 'zh' 
                    ? '可以直接上传图片或输入图片URL' 
                    : 'Upload an image directly or enter an image URL'}
                </Text>
                
                {/* 图片预览 */}
                {avatarUrl && (
                  <Box style={{ marginBottom: tokens.spacing[3] }}>
                    <Box
                      style={{
                        position: 'relative',
                        display: 'inline-block',
                      }}
                    >
                      <Image
                        src={avatarUrl}
                        alt="Avatar preview"
                        width={120}
                        height={120}
                        style={{
                          width: 120,
                          height: 120,
                          borderRadius: tokens.radius.lg,
                          objectFit: 'cover',
                          border: ('1px solid ' + tokens.colors.border.primary),
                        }}
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = 'none'
                        }}
                        unoptimized
                      />
                      <Button
                        type="button"
                        variant="text"
                        size="sm"
                        onClick={() => setAvatarUrl('')}
                        style={{
                          position: 'absolute',
                          top: -8,
                          right: -8,
                          padding: tokens.spacing[1],
                          minWidth: 'auto',
                          width: 24,
                          height: 24,
                          borderRadius: '50%',
                          background: tokens.colors.accent.error,
                          color: tokens.colors.white,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          border: 'none',
                        }}
                      >
                        ×
                      </Button>
                    </Box>
                  </Box>
                )}

                {/* 上传按钮和URL输入 */}
                <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
                  <Box style={{ display: 'flex', gap: tokens.spacing[2] }}>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/jpeg,image/jpg,image/png,image/gif,image/webp"
                      onChange={handleImageUpload}
                      style={{ display: 'none' }}
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={uploading}
                      style={{ flexShrink: 0 }}
                    >
                      {uploading 
                        ? (language === 'zh' ? '上传中...' : 'Uploading...')
                        : (language === 'zh' ? '上传图片' : 'Upload Image')}
                    </Button>
                    <Box style={{ flex: 1, display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
                      <Box
                        style={{
                          flex: 1,
                          height: 1,
                          background: tokens.colors.border.primary,
                        }}
                      />
                      <Text size="xs" color="tertiary" style={{ whiteSpace: 'nowrap' }}>
                        {language === 'zh' ? '或' : 'or'}
                      </Text>
                      <Box
                        style={{
                          flex: 1,
                          height: 1,
                          background: tokens.colors.border.primary,
                        }}
                      />
                    </Box>
                  </Box>
                  <input
                    type="url"
                    value={avatarUrl}
                    onChange={(e) => setAvatarUrl(e.target.value)}
                    placeholder="https://example.com/avatar.png"
                    style={inputStyle}
                  />
                </Box>
              </Box>

              {/* Pro 专属小组选项 */}
              {isPro && (
                <Box
                  style={{
                    padding: tokens.spacing[4],
                    background: 'var(--color-pro-glow)',
                    borderRadius: tokens.radius.lg,
                    border: '1px solid var(--color-pro-gradient-start)',
                  }}
                >
                  <Box style={{ display: 'flex', alignItems: 'flex-start', gap: tokens.spacing[3] }}>
                    <Box
                      onClick={() => setIsPremiumOnly(!isPremiumOnly)}
                      style={{
                        width: 20,
                        height: 20,
                        borderRadius: tokens.radius.sm,
                        border: isPremiumOnly 
                          ? '2px solid var(--color-pro-gradient-start)' 
                          : '2px solid var(--color-border-secondary)',
                        background: isPremiumOnly ? 'var(--color-pro-gradient-start)' : 'transparent',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                        flexShrink: 0,
                        marginTop: 2,
                        transition: 'all 0.2s',
                      }}
                    >
                      {isPremiumOnly && (
                        <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3">
                          <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </Box>
                    <Box style={{ flex: 1 }}>
                      <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], marginBottom: 4 }}>
                        <Text weight="bold" style={{ color: 'var(--color-pro-gradient-start)' }}>
                          {language === 'zh' ? 'Pro 专属小组' : 'Pro Exclusive Group'}
                        </Text>
                        <Box
                          style={{
                            padding: '2px 6px',
                            borderRadius: tokens.radius.full,
                            background: 'var(--color-pro-badge-bg)',
                            fontSize: 10,
                            fontWeight: 700,
                            color: tokens.colors.white,
                          }}
                        >
                          Pro
                        </Box>
                      </Box>
                      <Text size="sm" color="secondary" style={{ lineHeight: 1.5 }}>
                        {language === 'zh' 
                          ? '开启后，只有 Pro 会员才能加入此小组。组长和组员都需要是 Pro 会员。' 
                          : 'When enabled, only Pro members can join this group. Both the leader and members must be Pro members.'}
                      </Text>
                    </Box>
                  </Box>
                </Box>
              )}

              {/* 非 Pro 用户提示 */}
              {!isPro && (
                <Box
                  style={{
                    padding: tokens.spacing[4],
                    background: 'var(--color-bg-secondary)',
                    borderRadius: tokens.radius.lg,
                    border: '1px solid var(--color-border-primary)',
                  }}
                >
                  <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
                    <Box
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: tokens.radius.md,
                        background: 'var(--color-pro-glow)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                      }}
                    >
                      <svg width={18} height={18} viewBox="0 0 24 24" fill="var(--color-pro-gradient-start)">
                        <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
                      </svg>
                    </Box>
                    <Box style={{ flex: 1 }}>
                      <Text size="sm" weight="semibold" style={{ marginBottom: 2 }}>
                        {language === 'zh' ? '升级 Pro 创建专属小组' : 'Upgrade to Pro for Exclusive Groups'}
                      </Text>
                      <Text size="xs" color="tertiary">
                        {language === 'zh' 
                          ? 'Pro 会员可以创建只允许会员加入的专属小组' 
                          : 'Pro members can create exclusive groups that only members can join'}
                      </Text>
                    </Box>
                    <Link href="/pricing" style={{ textDecoration: 'none' }}>
                      <Button
                        variant="secondary"
                        size="sm"
                        style={{
                          background: 'var(--color-pro-glow)',
                          border: '1px solid var(--color-pro-gradient-start)',
                          color: 'var(--color-pro-gradient-start)',
                          fontWeight: 600,
                        }}
                      >
                        {language === 'zh' ? '升级' : 'Upgrade'}
                      </Button>
                    </Link>
                  </Box>
                </Box>
              )}

              {/* 角色称呼设置 */}
              <Box>
                <Text weight="bold" style={{ marginBottom: tokens.spacing[3] }}>
                  {language === 'zh' ? '角色称呼设置' : 'Role Names'}
                </Text>
                <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[3] }}>
                  {language === 'zh' 
                    ? '自定义小组内角色的称呼（可选）' 
                    : 'Customize role names for your group (optional)'}
                </Text>

                <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
                  {/* 管理员 */}
                  <Box style={{ display: 'grid', gridTemplateColumns: '100px 1fr 1fr', gap: tokens.spacing[2], alignItems: 'center' }}>
                    <Text size="sm" color="secondary">
                      {language === 'zh' ? '管理员' : 'Admin'}
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
                    background: `${tokens.colors.accent.error}15`,
                    borderRadius: tokens.radius.lg,
                    border: `1px solid ${tokens.colors.accent.error}30`,
                  }}
                >
                  <Text size="sm" style={{ color: tokens.colors.accent.error }}>
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
