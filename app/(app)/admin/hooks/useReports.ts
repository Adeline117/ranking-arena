'use client'

import { useState, useCallback } from 'react'
import { getCsrfHeaders } from '@/lib/api/client'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { logger } from '@/lib/logger'

type ToastFn = (message: string, type: 'success' | 'error' | 'warning' | 'info') => void

export interface ContentReport {
  id: string
  reporter_id: string
  content_type: 'post' | 'comment' | 'message' | 'user'
  content_id: string
  reason: string
  description: string | null
  images: string[] | null
  status: 'pending' | 'resolved' | 'dismissed'
  resolved_by: string | null
  resolved_at: string | null
  action_taken: string | null
  created_at: string
  reporter: {
    id: string
    handle: string | null
    avatar_url: string | null
  } | null
  contentPreview: {
    title?: string
    content?: string
  } | null
  contentAuthor: {
    id: string
    handle: string | null
  } | null
}

export interface ReportsPagination {
  page: number
  limit: number
  total: number
  totalPages: number
}

export function useReports(accessToken: string | null, showToast?: ToastFn) {
  const { t } = useLanguage()
  const [reports, setReports] = useState<ContentReport[]>([])
  const [pagination, setPagination] = useState<ReportsPagination>({
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 0,
  })
  const [loading, setLoading] = useState(false)
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({})

  const loadReports = useCallback(async (
    page: number = 1,
    status: 'pending' | 'resolved' | 'dismissed' | 'all' = 'pending',
    contentType: 'post' | 'comment' | 'message' | 'user' | 'all' = 'all'
  ) => {
    if (!accessToken) return
    
    setLoading(true)
    
    try {
      const params = new URLSearchParams({
        page: String(page),
        limit: '20',
        status,
        content_type: contentType,
      })
      
      const res = await fetch(`/api/admin/reports?${params}`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      })
      const data = await res.json()
      
      if (data.ok) {
        setReports(data.reports)
        setPagination(data.pagination)
      }
    } catch (err) {
      logger.error('Error loading reports:', err)
    } finally {
      setLoading(false)
    }
  }, [accessToken])

  const resolveReport = useCallback(async (
    reportId: string,
    action: 'resolve' | 'dismiss',
    reason?: string
  ) => {
    if (!accessToken) return false
    
    setActionLoading(prev => ({ ...prev, [reportId]: true }))
    
    try {
      const res = await fetch(`/api/admin/reports/${reportId}/resolve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          ...getCsrfHeaders()
        },
        body: JSON.stringify({ action, reason }),
      })
      const data = await res.json()
      
      if (data.ok) {
        // Remove from list or update status
        setReports(prev => prev.filter(r => r.id !== reportId))
        return true
      } else {
        showToast?.(data.error || t('adminOperationFailed'), 'error')
        return false
      }
    } catch (_err) {
      showToast?.(t('adminNetworkError'), 'error')
      return false
    } finally {
      setActionLoading(prev => ({ ...prev, [reportId]: false }))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t is a stable ref; setReports/setActionLoading use updater form
  }, [accessToken, showToast])

  return {
    reports,
    pagination,
    loading,
    actionLoading,
    loadReports,
    resolveReport,
  }
}
