'use client'

import { features } from '@/lib/features'
import { redirect } from 'next/navigation'
import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { getLocaleFromLanguage } from '@/lib/utils/format'
import { tokens, alpha } from '@/lib/design-tokens'
import Card from '@/app/components/ui/Card'
import { Box, Text, Button } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useSubscription } from '@/app/components/home/hooks/useSubscription'
import { useToast } from '@/app/components/ui/Toast'
import { authedFetch } from '@/lib/api/client'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { useUnsavedChangesGuard } from '@/lib/hooks/useUnsavedChangesGuard'
import { logger } from '@/lib/logger'
import { AvatarUploadSection } from './components/AvatarUploadSection'
import { ProGroupOption } from './components/ProGroupOption'
import { RoleNameSettings } from './components/RoleNameSettings'
import type { RoleNames, Rule } from './types'
import { tokenRefreshCoordinator } from '@/lib/auth/token-refresh'
import { jwtSubject } from '@/lib/auth/token-subject'
import { isViewerScopeCurrent, type ViewerScope } from '@/lib/auth/viewer-scope'
import {
  acquireGroupApplicationOperation,
  completeGroupApplicationOperation,
  isCurrentGroupApplicationOperation,
  isExactSubmitGroupApplicationAck,
  runGroupApplicationSingleFlight,
} from '@/lib/groups/application-operation'
import { useViewerSlotState } from '@/lib/groups/use-viewer-slot-state'

export default function ApplyGroupPage() {
  if (!features.social) redirect('/')

  const _router = useRouter()
  const { t, language } = useLanguage()
  const { isPro } = useSubscription()
  const { showToast } = useToast()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const submitOperationIdRef = useRef<Record<string, string>>({})
  const avatarUploadOperationIdRef = useRef<Record<string, number>>({})
  const nextAvatarUploadOperationIdRef = useRef(0)
  const { accessToken, email, userId, viewerKey, sessionGeneration } = useAuthSession()
  const stateOwnerKey = `${viewerKey}:${sessionGeneration}`
  const [loading, setLoading] = useViewerSlotState(stateOwnerKey, false)
  const [error, setError] = useViewerSlotState<string | null>(stateOwnerKey, null)
  const [success, setSuccess] = useViewerSlotState(stateOwnerKey, false)
  const [uploading, setUploading] = useViewerSlotState(stateOwnerKey, false)
  const [fieldErrors, setFieldErrors] = useViewerSlotState<Record<string, string>>(
    stateOwnerKey,
    {}
  )

  // 当前编辑的语言标签
  const [activeTab, setActiveTab] = useViewerSlotState<'zh' | 'en'>(stateOwnerKey, 'zh')
  // 是否显示多语言（英文）
  const [showMultiLang, setShowMultiLang] = useViewerSlotState(stateOwnerKey, false)

  // 表单状态 - 中文
  const [nameZh, setNameZh] = useViewerSlotState(stateOwnerKey, '')
  const [descriptionZh, setDescriptionZh] = useViewerSlotState(stateOwnerKey, '')

  // 表单状态 - 英文
  const [nameEn, setNameEn] = useViewerSlotState(stateOwnerKey, '')
  const [descriptionEn, setDescriptionEn] = useViewerSlotState(stateOwnerKey, '')

  // Draft-loss guard: prompt on tab close/refresh while the application has
  // content and isn't mid-submit (audit 实体/详情).
  useUnsavedChangesGuard(
    Boolean(nameZh.trim() || descriptionZh.trim() || nameEn.trim() || descriptionEn.trim()) &&
      !loading &&
      !success
  )

  // 小组规则（支持多条，中英文）
  const [rules, setRules] = useViewerSlotState<Rule[]>(stateOwnerKey, [])
  const [newRuleZh, setNewRuleZh] = useViewerSlotState(stateOwnerKey, '')
  const [newRuleEn, setNewRuleEn] = useViewerSlotState(stateOwnerKey, '')

  // 头像和角色称呼
  const [avatarUrl, setAvatarUrl] = useViewerSlotState(stateOwnerKey, '')
  const [roleNames, setRoleNames] = useViewerSlotState<RoleNames>(stateOwnerKey, {
    admin: { zh: '管理员', en: 'Admin' },
    member: { zh: '成员', en: 'Member' },
  })

  // Pro 专属小组选项
  const [isPremiumOnly, setIsPremiumOnly] = useViewerSlotState(stateOwnerKey, false)

  // 用户已有的申请
  const [existingApplications, setExistingApplications] = useViewerSlotState<any[]>(
    stateOwnerKey,
    []
  )

  useEffect(() => {
    if (accessToken) {
      fetchMyApplications(accessToken)
    }
  }, [accessToken, sessionGeneration, userId, viewerKey])

  // The DOM file input is shared across renders. Clear A's selected File as
  // soon as ownership changes, while stale A completions are forbidden from
  // clearing a later B selection.
  useEffect(() => {
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [stateOwnerKey])

  // Field-level validation
  const validateField = (fieldName: string, _value: string) => {
    const newErrors = { ...fieldErrors }

    if (fieldName === 'nameZh' || fieldName === 'nameEn') {
      if (!nameZh.trim() && !nameEn.trim()) {
        newErrors['name'] = t('nameRequiredError')
      } else {
        delete newErrors['name']
      }
    }

    setFieldErrors(newErrors)
  }

  const fetchMyApplications = async (token: string, requestScope?: ViewerScope) => {
    const scope = requestScope ?? { viewerKey, sessionGeneration, userId }
    if (
      !scope.userId ||
      scope.viewerKey !== `user:${scope.userId}` ||
      jwtSubject(token) !== scope.userId ||
      !isViewerScopeCurrent(scope)
    )
      return
    try {
      const result = await authedFetch<{ applications?: unknown[] }>(
        '/api/groups/apply',
        'GET',
        token,
        undefined,
        15_000,
        {
          expectedUserId: scope.userId,
          expectedSessionGeneration: scope.sessionGeneration,
        }
      )

      if (result.stale || !isViewerScopeCurrent(scope)) return
      if (!result.ok) {
        logger.warn('Failed to fetch applications:', result.status)
        return
      }

      if (result.data?.applications) {
        setExistingApplications(result.data.applications)
      }
    } catch (err) {
      logger.error('Error fetching applications:', err)
    }
  }

  const addRule = () => {
    const zhText = newRuleZh.trim()
    const enText = newRuleEn.trim()

    if (!zhText && !enText) return

    setRules([...rules, { zh: zhText, en: enText }])
    setNewRuleZh('')
    setNewRuleEn('')
  }

  const removeRule = (index: number) => {
    setRules(rules.filter((_, i) => i !== index))
  }

  const updateRule = (index: number, lang: 'zh' | 'en', value: string) => {
    const newRules = [...rules]
    newRules[index] = { ...newRules[index], [lang]: value }
    setRules(newRules)
  }

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const requestScope: ViewerScope = { viewerKey, sessionGeneration, userId }
    const files = e.target.files
    if (!files || files.length === 0) return

    if (
      !accessToken ||
      !userId ||
      requestScope.viewerKey !== `user:${userId}` ||
      jwtSubject(accessToken) !== userId ||
      !isViewerScopeCurrent(requestScope)
    ) {
      if (isViewerScopeCurrent(requestScope)) showToast(t('pleaseLoginFirst'), 'warning')
      return
    }

    const requestUserId = userId
    const requestOwnerKey = stateOwnerKey
    const input = e.currentTarget
    const file = files[0]
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']
    if (!allowedTypes.includes(file.type)) {
      showToast(t('unsupportedImageFormat'), 'error')
      return
    }

    if (file.size > 5 * 1024 * 1024) {
      showToast(t('imageSizeExceed5MB'), 'error')
      return
    }

    const uploadOperationId = ++nextAvatarUploadOperationIdRef.current
    avatarUploadOperationIdRef.current[requestOwnerKey] = uploadOperationId
    const operationOwnsSlot = () =>
      avatarUploadOperationIdRef.current[requestOwnerKey] === uploadOperationId
    const operationIsCurrent = () => operationOwnsSlot() && isViewerScopeCurrent(requestScope)

    setUploading(true)

    try {
      const uploadToken = await tokenRefreshCoordinator.getValidToken({
        expectedUserId: requestUserId,
        sessionGeneration: requestScope.sessionGeneration,
      })
      if (!uploadToken || jwtSubject(uploadToken) !== requestUserId) {
        if (operationIsCurrent()) showToast(t('authenticationFailed'), 'error')
        return
      }
      if (!operationIsCurrent()) return

      const formData = new FormData()
      formData.append('file', file)
      formData.append('userId', requestUserId)

      // /api/posts/upload-image is withAuth (Bearer header only) — 401'd without the token
      const response = await fetch('/api/posts/upload-image', {
        method: 'POST',
        headers: { Authorization: `Bearer ${uploadToken}` },
        body: formData,
      })
      if (!operationIsCurrent()) return

      if (!response.ok) {
        let errorMsg = t('uploadFailed')
        try {
          const errorData = await response.json()
          if (!operationIsCurrent()) return
          errorMsg = errorData.error || errorMsg
        } catch {
          if (!operationIsCurrent()) return
          errorMsg = `${errorMsg} (${response.status})`
        }
        if (operationIsCurrent()) showToast(errorMsg, 'error')
        return
      }

      const data = await response.json()
      if (!operationIsCurrent()) return
      setAvatarUrl(data.url)
      showToast(t('imageUploadSuccess'), 'success')
    } catch (error: unknown) {
      if (!operationIsCurrent()) return
      logger.error('Upload error:', error)
      const errorMsg = error instanceof Error ? error.message : t('networkError')
      showToast(errorMsg, 'error')
    } finally {
      const ownsOperation = operationOwnsSlot()
      if (ownsOperation) delete avatarUploadOperationIdRef.current[requestOwnerKey]
      if (ownsOperation && isViewerScopeCurrent(requestScope)) {
        setUploading(false)
        if (fileInputRef.current === input) input.value = ''
      }
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    const requestScope: ViewerScope = { viewerKey, sessionGeneration, userId }
    if (
      !accessToken ||
      !userId ||
      jwtSubject(accessToken) !== userId ||
      requestScope.viewerKey !== `user:${userId}` ||
      !isViewerScopeCurrent(requestScope)
    ) {
      setError(t('pleaseLoginFirst'))
      return
    }

    const newErrors: Record<string, string> = {}

    if (!nameZh.trim() && !nameEn.trim()) {
      newErrors['name'] = t('nameRequiredError')
    }

    if (Object.keys(newErrors).length > 0) {
      setFieldErrors(newErrors)
      setError(t('fixFormErrors'))
      return
    }

    let activeOperationId: string | null = null
    try {
      const intent = {
        name: nameZh.trim() || nameEn.trim(),
        name_en: nameEn.trim() || null,
        description: descriptionZh.trim() || null,
        description_en: descriptionEn.trim() || null,
        avatar_url: avatarUrl.trim() || null,
        role_names: roleNames,
        rules_json: rules.length > 0 ? rules : null,
        rules:
          rules
            .map((r) => r.zh)
            .filter(Boolean)
            .join('\n') || null,
        is_premium_only: isPro && isPremiumOnly,
      }
      const operation = await acquireGroupApplicationOperation(`submit:${userId}`, userId, intent)
      if (!isViewerScopeCurrent(requestScope)) return
      activeOperationId = operation.operationId
      submitOperationIdRef.current[stateOwnerKey] = activeOperationId
      setLoading(true)
      setError(null)

      const result = await runGroupApplicationSingleFlight(operation, () =>
        authedFetch<unknown>(
          '/api/groups/apply',
          'POST',
          accessToken,
          { ...intent, operation_id: operation.operationId },
          15_000,
          {
            expectedUserId: userId,
            expectedSessionGeneration: sessionGeneration,
          }
        )
      )
      if (result.stale || !isViewerScopeCurrent(requestScope)) return
      const ownsActiveIntent = submitOperationIdRef.current[stateOwnerKey] === operation.operationId
      const data = result.data

      if (!result.ok) {
        if (!ownsActiveIntent) return
        let errorMessage = t('submissionFailed')

        if (typeof data === 'object' && data !== null) {
          const errorData = data as { error?: unknown; message?: unknown }
          if (typeof errorData.error === 'string') {
            errorMessage = errorData.error
          } else if (typeof errorData.message === 'string') {
            errorMessage = errorData.message
          }
        } else {
          if (result.status === 401) {
            errorMessage = t('authenticationFailed')
          } else if (result.status === 403) {
            errorMessage = t('permissionDenied')
          } else if (result.status === 400) {
            errorMessage = t('invalidRequestParams')
          } else if (result.status === 500) {
            errorMessage = t('serverError')
          }
        }
        setError(errorMessage)
        return
      }

      if (!isExactSubmitGroupApplicationAck(data, operation)) {
        if (ownsActiveIntent) setError(t('submissionFailed'))
        return
      }

      void fetchMyApplications(accessToken, requestScope)
      if (ownsActiveIntent) {
        if (isCurrentGroupApplicationOperation(operation)) {
          completeGroupApplicationOperation(operation)
        }
        setSuccess(true)
      }
    } catch (err) {
      if (
        !isViewerScopeCurrent(requestScope) ||
        (activeOperationId !== null &&
          submitOperationIdRef.current[stateOwnerKey] !== activeOperationId)
      ) {
        return
      }
      logger.error('Submit error:', err)
      let errorMessage = t('networkErrorCheckConnection')

      if (err instanceof TypeError && err.message.includes('fetch')) {
        errorMessage = t('cannotConnectToServer')
      }

      setError(errorMessage)
    } finally {
      const completedOperationId = activeOperationId
      if (completedOperationId !== null)
        queueMicrotask(() => {
          if (
            submitOperationIdRef.current[stateOwnerKey] === completedOperationId &&
            isViewerScopeCurrent(requestScope)
          ) {
            delete submitOperationIdRef.current[stateOwnerKey]
            setLoading(false)
          }
        })
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
    borderRadius: tokens.radius.lg,
    border: '1px solid ' + tokens.colors.border.primary,
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
    border: `1px solid ${isActive ? tokens.colors.border.primary : 'transparent'}`,
    borderBottom: isActive ? 'none' : `1px solid ${tokens.colors.border.primary}`,
    background: isActive ? tokens.colors.bg.secondary : 'transparent',
    color: isActive ? tokens.colors.text.primary : tokens.colors.text.tertiary,
    cursor: 'pointer',
    fontWeight: isActive ? tokens.typography.fontWeight.bold : tokens.typography.fontWeight.medium,
    transition: `all ${tokens.transition.base}`,
  })

  const getStatusBadge = (status: string) => {
    const styles: Record<string, { bg: string; color: string; key: string }> = {
      pending: {
        bg: 'var(--color-orange-bg-light)',
        color: 'var(--color-accent-warning)',
        key: 'pendingReview',
      },
      approved: {
        bg: 'var(--color-accent-success-20)',
        color: 'var(--color-accent-success)',
        key: 'approved',
      },
      rejected: {
        bg: 'var(--color-red-bg-light)',
        color: 'var(--color-accent-error)',
        key: 'rejected',
      },
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
        {t(style.key)}
      </Box>
    )
  }

  if (!accessToken) {
    return (
      <Box
        style={{
          minHeight: '100vh',
          background: tokens.colors.bg.primary,
          color: tokens.colors.text.primary,
        }}
      >
        <Box as="main" style={{ maxWidth: 600, margin: '0 auto', padding: tokens.spacing[6] }}>
          <Card title={t('applyCreateGroup')}>
            <Box style={{ textAlign: 'center', padding: tokens.spacing[8] }}>
              <Text size="lg" color="tertiary" style={{ marginBottom: tokens.spacing[4] }}>
                {t('groupApplyLoginRequired')}
              </Text>
              <Link href="/login?redirect=/groups/apply">
                <Button variant="primary">{t('goToLogin')}</Button>
              </Link>
            </Box>
          </Card>
        </Box>
      </Box>
    )
  }

  if (success) {
    return (
      <Box
        style={{
          minHeight: '100vh',
          background: tokens.colors.bg.primary,
          color: tokens.colors.text.primary,
        }}
      >
        <Box as="main" style={{ maxWidth: 600, margin: '0 auto', padding: tokens.spacing[6] }}>
          <Card title={t('groupApplySubmittedTitle')}>
            <Box style={{ textAlign: 'center', padding: tokens.spacing[8] }}>
              <Box
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: '50%',
                  background: 'var(--color-accent-primary-20)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  margin: '0 auto',
                  marginBottom: tokens.spacing[4],
                }}
              >
                <svg
                  width="32"
                  height="32"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke={tokens.colors.accent.brand}
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
              </Box>
              <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
                {t('groupApplySubmittedTitle')}
              </Text>
              <Text color="tertiary" style={{ marginBottom: tokens.spacing[6] }}>
                {t('groupApplyPendingDesc')}
              </Text>
              <Box style={{ display: 'flex', gap: tokens.spacing[3], justifyContent: 'center' }}>
                <Button variant="secondary" onClick={() => setSuccess(false)}>
                  {t('applyAnother')}
                </Button>
                <Link href="/groups">
                  <Button variant="primary">{t('backToGroups')}</Button>
                </Link>
              </Box>
            </Box>
          </Card>
        </Box>
      </Box>
    )
  }

  return (
    <Box
      style={{
        minHeight: '100vh',
        background: tokens.colors.bg.primary,
        color: tokens.colors.text.primary,
      }}
    >
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
          ← {t('backToGroups')}
        </Link>

        {/* 已有的申请 */}
        {existingApplications.length > 0 && (
          <Card title={t('myApplications')} style={{ marginBottom: tokens.spacing[6] }}>
            <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
              {existingApplications.map((app) => (
                <Box
                  key={app.id}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: tokens.spacing[2],
                    padding: tokens.spacing[3],
                    background: tokens.colors.bg.secondary,
                    borderRadius: tokens.radius.lg,
                    border: '1px solid ' + tokens.colors.border.primary,
                  }}
                >
                  <Box
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <Box>
                      <Text weight="bold">{app.name}</Text>
                      <Text size="xs" color="tertiary">
                        {new Date(app.created_at).toLocaleString(getLocaleFromLanguage(language))}
                      </Text>
                    </Box>
                    {getStatusBadge(app.status)}
                  </Box>

                  {/* approved → 前往小组链接（U9-10 死信息修复） */}
                  {app.status === 'approved' && app.group_id && (
                    <Link href={`/groups/${app.group_id}`} style={{ textDecoration: 'none' }}>
                      <Button variant="secondary" size="sm">
                        {t('groupApplyGoToGroup')} →
                      </Button>
                    </Link>
                  )}

                  {/* rejected → 显示拒绝原因 */}
                  {app.status === 'rejected' && app.reject_reason && (
                    <Text size="xs" style={{ color: tokens.colors.accent.error }}>
                      {t('groupApplyRejectReasonLabel').replace('{reason}', app.reject_reason)}
                    </Text>
                  )}
                </Box>
              ))}
            </Box>
          </Card>
        )}

        {/* 申请表单 */}
        <Card title={t('applyCreateGroup')}>
          <form onSubmit={handleSubmit}>
            <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[5] }}>
              {/* 语言标签页 */}
              <Box>
                <Box
                  style={{
                    display: 'flex',
                    borderBottom: '1px solid ' + tokens.colors.border.primary,
                  }}
                >
                  <button
                    type="button"
                    style={tabStyle(activeTab === 'zh')}
                    onClick={() => setActiveTab('zh')}
                  >
                    {t('chinese')}
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
                      + {t('addLanguageBtn')}
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
                    borderRadius: '0 0 ' + tokens.radius.lg + ' ' + tokens.radius.lg,
                    border: '1px solid ' + tokens.colors.border.primary,
                    borderTop: 'none',
                  }}
                >
                  <Box>
                    <label style={labelStyle}>{t('groupNameRequired')}</label>
                    <input
                      type="text"
                      value={nameZh}
                      onChange={(e) => {
                        setNameZh(e.target.value)
                        if (fieldErrors.name) {
                          const newErrors = { ...fieldErrors }
                          delete newErrors['name']
                          setFieldErrors(newErrors)
                        }
                      }}
                      onBlur={() => validateField('nameZh', nameZh)}
                      placeholder={t('groupNameZhPlaceholder')}
                      style={{
                        ...inputStyle,
                        borderColor: fieldErrors.name
                          ? tokens.colors.accent.error
                          : tokens.colors.border.primary,
                      }}
                      aria-invalid={!!fieldErrors.name}
                      maxLength={50}
                      autoFocus
                    />
                    {fieldErrors.name && (
                      <Text
                        size="xs"
                        style={{ color: tokens.colors.accent.error, marginTop: tokens.spacing[1] }}
                      >
                        {fieldErrors.name}
                      </Text>
                    )}
                  </Box>

                  <Box>
                    <Box
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <label style={labelStyle}>{t('groupDescription')}</label>
                    </Box>
                    <textarea
                      value={descriptionZh}
                      onChange={(e) => setDescriptionZh(e.target.value)}
                      placeholder={t('groupDescZhPlaceholder')}
                      style={{ ...inputStyle, minHeight: 100, resize: 'vertical' }}
                      maxLength={500}
                    />
                    <Text
                      size="xs"
                      style={{
                        textAlign: 'right',
                        marginTop: tokens.spacing[1],
                        color:
                          descriptionZh.length > 450
                            ? tokens.colors.accent.warning
                            : tokens.colors.text.tertiary,
                      }}
                    >
                      {descriptionZh.length}/500
                    </Text>
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
                      borderRadius: '0 0 ' + tokens.radius.lg + ' ' + tokens.radius.lg,
                      border: '1px solid ' + tokens.colors.border.primary,
                      borderTop: 'none',
                    }}
                  >
                    <Box
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <Text size="sm" color="tertiary">
                        English Version
                      </Text>
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
                        {t('removeEnglish')}
                      </Button>
                    </Box>

                    <Box>
                      <label style={labelStyle}>Group Name</label>
                      <input
                        type="text"
                        value={nameEn}
                        onChange={(e) => {
                          setNameEn(e.target.value)
                          if (fieldErrors.name) {
                            const newErrors = { ...fieldErrors }
                            delete newErrors['name']
                            setFieldErrors(newErrors)
                          }
                        }}
                        onBlur={() => validateField('nameEn', nameEn)}
                        placeholder="e.g., BTC Trading Discussion"
                        style={{
                          ...inputStyle,
                          borderColor: fieldErrors.name
                            ? tokens.colors.accent.error
                            : tokens.colors.border.primary,
                        }}
                        aria-invalid={!!fieldErrors.name}
                        maxLength={50}
                      />
                      {fieldErrors.name && (
                        <Text
                          size="xs"
                          style={{
                            color: tokens.colors.accent.error,
                            marginTop: tokens.spacing[1],
                          }}
                        >
                          {fieldErrors.name}
                        </Text>
                      )}
                    </Box>

                    <Box>
                      <label style={labelStyle}>Group Description</label>
                      <textarea
                        value={descriptionEn}
                        onChange={(e) => setDescriptionEn(e.target.value)}
                        placeholder="Describe your group..."
                        style={{ ...inputStyle, minHeight: 100, resize: 'vertical' }}
                        maxLength={500}
                      />
                      <Text
                        size="xs"
                        style={{
                          textAlign: 'right',
                          marginTop: tokens.spacing[1],
                          color:
                            descriptionEn.length > 450
                              ? tokens.colors.accent.warning
                              : tokens.colors.text.tertiary,
                        }}
                      >
                        {descriptionEn.length}/500
                      </Text>
                    </Box>
                  </Box>
                )}
              </Box>

              {/* 小组规则 */}
              <Box>
                <Text weight="bold" style={{ marginBottom: tokens.spacing[3] }}>
                  {t('groupRules')}
                </Text>
                <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[3] }}>
                  {t('groupRulesDesc')}
                </Text>

                {rules.length > 0 && (
                  <Box
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: tokens.spacing[2],
                      marginBottom: tokens.spacing[3],
                    }}
                  >
                    {rules.map((rule, index) => (
                      <Box
                        key={index}
                        style={{
                          padding: tokens.spacing[3],
                          background: tokens.colors.bg.secondary,
                          borderRadius: tokens.radius.lg,
                          border: '1px solid ' + tokens.colors.border.primary,
                        }}
                      >
                        <Box
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'flex-start',
                            marginBottom: tokens.spacing[2],
                          }}
                        >
                          <Text size="sm" weight="bold" color="secondary">
                            {t('ruleNumber').replace('{n}', String(index + 1))}
                          </Text>
                          <Button
                            type="button"
                            variant="text"
                            size="sm"
                            onClick={() => removeRule(index)}
                            style={{
                              padding: 0,
                              color: 'var(--color-accent-error)',
                              fontSize: tokens.typography.fontSize.xs,
                            }}
                          >
                            {t('delete')}
                          </Button>
                        </Box>

                        <Box
                          style={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: tokens.spacing[2],
                          }}
                        >
                          <Box>
                            <Text size="xs" color="tertiary" style={{ marginBottom: 4 }}>
                              {t('chinese')}
                            </Text>
                            <input
                              type="text"
                              value={rule.zh}
                              onChange={(e) => updateRule(index, 'zh', e.target.value)}
                              style={{
                                ...inputStyle,
                                padding: tokens.spacing[2],
                                fontSize: tokens.typography.fontSize.sm,
                              }}
                              placeholder={t('ruleContentZhPlaceholder')}
                            />
                          </Box>
                          {showMultiLang && (
                            <Box>
                              <Text size="xs" color="tertiary" style={{ marginBottom: 4 }}>
                                English
                              </Text>
                              <input
                                type="text"
                                value={rule.en}
                                onChange={(e) => updateRule(index, 'en', e.target.value)}
                                style={{
                                  ...inputStyle,
                                  padding: tokens.spacing[2],
                                  fontSize: tokens.typography.fontSize.sm,
                                }}
                                placeholder={t('ruleContentEnPlaceholder')}
                              />
                            </Box>
                          )}
                        </Box>
                      </Box>
                    ))}
                  </Box>
                )}

                <Box
                  style={{
                    padding: tokens.spacing[3],
                    background: tokens.colors.bg.secondary,
                    borderRadius: tokens.radius.lg,
                    border: '1px dashed ' + tokens.colors.border.primary,
                  }}
                >
                  <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[2] }}>
                    {t('addNewRule')}
                  </Text>
                  <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
                    <input
                      type="text"
                      value={newRuleZh}
                      onChange={(e) => setNewRuleZh(e.target.value)}
                      style={{
                        ...inputStyle,
                        padding: tokens.spacing[2],
                        fontSize: tokens.typography.fontSize.sm,
                      }}
                      placeholder={t('ruleInputZhPlaceholder')}
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
                        style={{
                          ...inputStyle,
                          padding: tokens.spacing[2],
                          fontSize: tokens.typography.fontSize.sm,
                        }}
                        placeholder={t('ruleInputEnPlaceholder')}
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
                      + {t('addRule')}
                    </Button>
                  </Box>
                </Box>
              </Box>

              {/* 小组头像 */}
              <AvatarUploadSection
                avatarUrl={avatarUrl}
                setAvatarUrl={setAvatarUrl}
                uploading={uploading}
                fileInputRef={fileInputRef}
                onImageUpload={handleImageUpload}
              />

              {/* Pro 专属小组选项 */}
              <ProGroupOption
                isPro={isPro}
                isPremiumOnly={isPremiumOnly}
                setIsPremiumOnly={setIsPremiumOnly}
              />

              {/* 角色称呼设置 */}
              <RoleNameSettings roleNames={roleNames} setRoleNames={setRoleNames} />

              {error && (
                <Box
                  style={{
                    padding: tokens.spacing[3],
                    background: `${alpha(tokens.colors.accent.error, 8)}`,
                    borderRadius: tokens.radius.lg,
                    border: `1px solid ${alpha(tokens.colors.accent.error, 19)}`,
                  }}
                >
                  <Text size="sm" style={{ color: tokens.colors.accent.error }}>
                    {error}
                  </Text>
                </Box>
              )}

              <Box style={{ display: 'flex', gap: tokens.spacing[3], justifyContent: 'flex-end' }}>
                <Link href="/groups">
                  <Button variant="secondary" type="button">
                    {t('cancel')}
                  </Button>
                </Link>
                <Button variant="primary" type="submit" disabled={loading}>
                  {loading ? t('submittingText') : t('submitApplication')}
                </Button>
              </Box>
            </Box>
          </form>
        </Card>
      </Box>
    </Box>
  )
}
