'use client'

import { useState, useCallback } from 'react'
import { getCsrfHeaders } from '@/lib/api/client'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { logger } from '@/lib/logger'

type ToastFn = (message: string, type: 'success' | 'error' | 'warning' | 'info') => void

export interface GroupApplication {
  id: string
  applicant_id: string
  name: string
  name_en?: string | null
  description?: string | null
  description_en?: string | null
  avatar_url?: string | null
  role_names?: { admin?: { zh?: string; en?: string }; member?: { zh?: string; en?: string } } | null
  status: string
  reject_reason?: string | null
  created_at: string
  applicant?: {
    id: string
    handle?: string | null
    avatar_url?: string | null
  }
}

export interface GroupEditApplication {
  id: string
  group_id: string
  applicant_id: string
  name?: string | null
  name_en?: string | null
  description?: string | null
  description_en?: string | null
  avatar_url?: string | null
  rules_json?: Record<string, unknown> | null
  rules?: string | null
  role_names?: { admin?: { zh?: string; en?: string }; member?: { zh?: string; en?: string } } | null
  status: string
  reject_reason?: string | null
  created_at: string
  group?: {
    id: string
    name: string
    name_en?: string | null
  }
  applicant?: {
    handle?: string | null
    avatar_url?: string | null
  }
}

export function useApplications(accessToken: string | null, showToast?: ToastFn) {
  const { t } = useLanguage()
  const [applications, setApplications] = useState<GroupApplication[]>([])
  const [editApplications, setEditApplications] = useState<GroupEditApplication[]>([])
  const [applicationsLoading, setApplicationsLoading] = useState(false)
  const [editApplicationsLoading, setEditApplicationsLoading] = useState(false)
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({})

  const loadApplications = useCallback(async () => {
    if (!accessToken) return
    
    setApplicationsLoading(true)
    
    try {
      const res = await fetch('/api/groups/applications?status=pending', {
        headers: { Authorization: `Bearer ${accessToken}` }
      })
      const data = await res.json()
      
      if (data.applications) {
        setApplications(data.applications)
      }
    } catch (err) {
      logger.error('Error loading applications:', err)
    } finally {
      setApplicationsLoading(false)
    }
  }, [accessToken])

  const loadEditApplications = useCallback(async () => {
    if (!accessToken) return
    
    setEditApplicationsLoading(true)
    
    try {
      const res = await fetch('/api/groups/edit-applications?status=pending', {
        headers: { Authorization: `Bearer ${accessToken}` }
      })
      const data = await res.json()
      
      if (data.applications) {
        setEditApplications(data.applications)
      }
    } catch (err) {
      logger.error('Error loading edit applications:', err)
    } finally {
      setEditApplicationsLoading(false)
    }
  }, [accessToken])

  const approveApplication = useCallback(async (applicationId: string) => {
    if (!accessToken) return false
    
    setActionLoading(prev => ({ ...prev, [applicationId]: true }))
    
    try {
      const res = await fetch(`/api/groups/applications/${applicationId}/approve`, {
        method: 'POST',
        headers: { 
          Authorization: `Bearer ${accessToken}`,
          ...getCsrfHeaders()
        }
      })
      const data = await res.json()
      
      if (res.ok) {
        setApplications(prev => prev.filter(a => a.id !== applicationId))
        return true
      } else {
        showToast?.(data.error || t('adminOperationFailed'), 'error')
        return false
      }
    } catch (_err) {
      showToast?.(t('adminNetworkError'), 'error')
      return false
    } finally {
      setActionLoading(prev => ({ ...prev, [applicationId]: false }))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t is a stable ref; setApplications/setActionLoading use updater form
  }, [accessToken, showToast])

  const rejectApplication = useCallback(async (applicationId: string, reason?: string) => {
    if (!accessToken) return false
    
    setActionLoading(prev => ({ ...prev, [applicationId]: true }))
    
    try {
      const res = await fetch(`/api/groups/applications/${applicationId}/reject`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          ...getCsrfHeaders()
        },
        body: JSON.stringify({ reason })
      })
      const data = await res.json()
      
      if (res.ok) {
        setApplications(prev => prev.filter(a => a.id !== applicationId))
        return true
      } else {
        showToast?.(data.error || t('adminOperationFailed'), 'error')
        return false
      }
    } catch (_err) {
      showToast?.(t('adminNetworkError'), 'error')
      return false
    } finally {
      setActionLoading(prev => ({ ...prev, [applicationId]: false }))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t is a stable ref; setApplications/setActionLoading use updater form
  }, [accessToken, showToast])

  const approveEditApplication = useCallback(async (applicationId: string) => {
    if (!accessToken) return false
    
    setActionLoading(prev => ({ ...prev, [`edit_${applicationId}`]: true }))
    
    try {
      const res = await fetch(`/api/groups/edit-applications/${applicationId}/approve`, {
        method: 'POST',
        headers: { 
          Authorization: `Bearer ${accessToken}`,
          ...getCsrfHeaders()
        }
      })
      const data = await res.json()
      
      if (res.ok) {
        setEditApplications(prev => prev.filter(a => a.id !== applicationId))
        return true
      } else {
        showToast?.(data.error || t('adminOperationFailed'), 'error')
        return false
      }
    } catch (_err) {
      showToast?.(t('adminNetworkError'), 'error')
      return false
    } finally {
      setActionLoading(prev => ({ ...prev, [`edit_${applicationId}`]: false }))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t is a stable ref; setEditApplications/setActionLoading use updater form
  }, [accessToken, showToast])

  const rejectEditApplication = useCallback(async (applicationId: string, reason?: string) => {
    if (!accessToken) return false
    
    setActionLoading(prev => ({ ...prev, [`edit_${applicationId}`]: true }))
    
    try {
      const res = await fetch(`/api/groups/edit-applications/${applicationId}/reject`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          ...getCsrfHeaders()
        },
        body: JSON.stringify({ reason })
      })
      const data = await res.json()
      
      if (res.ok) {
        setEditApplications(prev => prev.filter(a => a.id !== applicationId))
        return true
      } else {
        showToast?.(data.error || t('adminOperationFailed'), 'error')
        return false
      }
    } catch (_err) {
      showToast?.(t('adminNetworkError'), 'error')
      return false
    } finally {
      setActionLoading(prev => ({ ...prev, [`edit_${applicationId}`]: false }))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t is a stable ref; setEditApplications/setActionLoading use updater form
  }, [accessToken, showToast])

  return {
    applications,
    editApplications,
    applicationsLoading,
    editApplicationsLoading,
    actionLoading,
    loadApplications,
    loadEditApplications,
    approveApplication,
    rejectApplication,
    approveEditApplication,
    rejectEditApplication,
  }
}
