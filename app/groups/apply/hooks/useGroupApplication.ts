'use client'

import { useState, useEffect, useRef } from 'react'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useSubscription } from '@/app/components/home/hooks/useSubscription'
import { useToast } from '@/app/components/ui/Toast'
import { getCsrfHeaders } from '@/lib/api/client'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { logger } from '@/lib/logger'
import type { RoleNames, Rule } from '../types'

export function useGroupApplication() {
  const { t } = useLanguage()
  const { isPro } = useSubscription()
  const { showToast } = useToast()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { accessToken, email, userId } = useAuthSession()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  // Language tab state
  const [activeTab, setActiveTab] = useState<'zh' | 'en'>('zh')
  const [showMultiLang, setShowMultiLang] = useState(false)

  // Form state - Chinese
  const [nameZh, setNameZh] = useState('')
  const [descriptionZh, setDescriptionZh] = useState('')

  // Form state - English
  const [nameEn, setNameEn] = useState('')
  const [descriptionEn, setDescriptionEn] = useState('')

  // Group rules (multi-entry, bilingual)
  const [rules, setRules] = useState<Rule[]>([])
  const [newRuleZh, setNewRuleZh] = useState('')
  const [newRuleEn, setNewRuleEn] = useState('')

  // Avatar and role names
  const [avatarUrl, setAvatarUrl] = useState('')
  const [roleNames, setRoleNames] = useState<RoleNames>({
    admin: { zh: '管理员', en: 'Admin' },
    member: { zh: '成员', en: 'Member' }
  })

  // Pro exclusive group option
  const [isPremiumOnly, setIsPremiumOnly] = useState(false)

  // Existing applications
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
      if (!nameZh.trim() && !nameEn.trim()) {
        newErrors['name'] = t('nameRequiredError')
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
        logger.warn('Failed to fetch applications:', res.status)
        return
      }

      const data = await res.json()
      if (data.applications) {
        setExistingApplications(data.applications)
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
    const files = e.target.files
    if (!files || files.length === 0) return

    if (!userId) {
      showToast(t('pleaseLoginFirst'), 'warning')
      return
    }

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
        let errorMsg = t('uploadFailed')
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
      showToast(t('imageUploadSuccess'), 'success')
    } catch (error: unknown) {
      logger.error('Upload error:', error)
      const errorMsg = error instanceof Error ? error.message : t('networkError')
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

    setLoading(true)
    setError(null)

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
          rules: rules.map(r => r.zh).filter(Boolean).join('\n') || null,
          is_premium_only: isPro && isPremiumOnly,
        })
      })

      if (!res.ok) {
        let errorMessage = t('submissionFailed')

        try {
          const data = await res.json()
          if (data.error) {
            errorMessage = data.error
          } else if (data.message) {
            errorMessage = data.message
          }
        } catch (_parseError) {
          if (res.status === 401) {
            errorMessage = t('authenticationFailed')
          } else if (res.status === 403) {
            errorMessage = t('permissionDenied')
          } else if (res.status === 400) {
            errorMessage = t('invalidRequestParams')
          } else if (res.status === 500) {
            errorMessage = t('serverError')
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
      logger.error('Submit error:', err)
      let errorMessage = t('networkErrorCheckConnection')

      if (err instanceof TypeError && err.message.includes('fetch')) {
        errorMessage = t('cannotConnectToServer')
      }

      setError(errorMessage)
    } finally {
      setLoading(false)
    }
  }

  return {
    // Auth
    accessToken,
    email,
    // Loading / status
    loading,
    error,
    success,
    setSuccess,
    uploading,
    fieldErrors,
    setFieldErrors,
    // Language tabs
    activeTab,
    setActiveTab,
    showMultiLang,
    setShowMultiLang,
    // Form fields
    nameZh,
    setNameZh,
    nameEn,
    setNameEn,
    descriptionZh,
    setDescriptionZh,
    descriptionEn,
    setDescriptionEn,
    // Rules
    rules,
    newRuleZh,
    setNewRuleZh,
    newRuleEn,
    setNewRuleEn,
    addRule,
    removeRule,
    updateRule,
    // Avatar
    avatarUrl,
    setAvatarUrl,
    fileInputRef,
    handleImageUpload,
    // Roles
    roleNames,
    setRoleNames,
    // Pro
    isPro,
    isPremiumOnly,
    setIsPremiumOnly,
    // Applications
    existingApplications,
    // Actions
    validateField,
    handleSubmit,
  }
}
