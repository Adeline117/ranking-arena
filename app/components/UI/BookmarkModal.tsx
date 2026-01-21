'use client'

import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '../Base'
import { supabase } from '@/lib/supabase/client'
import { getCsrfHeaders } from '@/lib/api/client'

type BookmarkFolder = {
  id: string
  name: string
  description?: string
  avatar_url?: string
  is_public: boolean
  is_default: boolean
  post_count: number
}

interface BookmarkModalProps {
  isOpen: boolean
  onClose: () => void
  onSelect: (folderId: string) => void
  postId: string
}

export default function BookmarkModal({ isOpen, onClose, onSelect, postId }: BookmarkModalProps) {
  const [folders, setFolders] = useState<BookmarkFolder[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [newFolderPublic, setNewFolderPublic] = useState(true)
  const [accessToken, setAccessToken] = useState<string | null>(null)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setAccessToken(data.session?.access_token ?? null)
    })
  }, [])

  useEffect(() => {
    if (isOpen && accessToken) {
      loadFolders()
    }
    // 关闭时重置状态
    if (!isOpen) {
      setShowCreateForm(false)
      setNewFolderName('')
      setNewFolderPublic(true)
    }
  }, [isOpen, accessToken])

  // 打开弹窗时禁止背景滚动，ESC 键关闭
  useEffect(() => {
    if (!isOpen) return
    
    const originalOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    
    return () => {
      document.body.style.overflow = originalOverflow
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen, onClose])

  const loadFolders = async () => {
    setLoading(true)

    try {
      // 统一获取 token，避免竞争条件
      let token = accessToken
      if (!token) {
        const { data } = await supabase.auth.getSession()
        token = data.session?.access_token ?? null
        if (token) {
          setAccessToken(token)
        }
      }

      if (!token) {
        setFolders([])
        return
      }

      const response = await fetch('/api/bookmark-folders', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      })

      // 如果返回 401，不做重定向，只是清空收藏夹
      if (response.status === 401) {
        setFolders([])
        return
      }

      const data = await response.json()
      if (response.ok) {
        // API 返回格式: { success: true, data: { folders: [...] } }
        setFolders(data.data?.folders || data.folders || [])
      }
    } catch (error) {
      console.error('加载收藏夹失败:', error)
      setFolders([])
    } finally {
      setLoading(false)
    }
  }

  const createFolder = async () => {
    if (!newFolderName.trim() || !accessToken) return
    
    setCreating(true)
    try {
      const response = await fetch('/api/bookmark-folders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          ...getCsrfHeaders()
        },
        body: JSON.stringify({
          name: newFolderName.trim(),
          is_public: newFolderPublic
        })
      })
      
      const data = await response.json()
      if (response.ok) {
        // API 返回格式: { success: true, data: { folder: {...} } }
        const newFolder = data.data?.folder || data.folder
        if (newFolder) {
          setFolders(prev => [...prev, newFolder])
        }
        setNewFolderName('')
        setNewFolderPublic(true)  // 重置为默认公开
        setShowCreateForm(false)
      } else {
        alert(data.error?.message || data.error || '创建失败')
      }
    } catch (error) {
      alert('创建失败')
    } finally {
      setCreating(false)
    }
  }

  const handleSelectFolder = (folderId: string) => {
    onSelect(folderId)
    onClose()
  }

  const getDefaultAvatar = (name: string) => {
    const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD', '#98D8C8']
    const index = name.charCodeAt(0) % colors.length
    return colors[index]
  }

  // 使用 Portal 渲染到 document.body，确保弹窗显示在所有元素之上
  if (!isOpen || typeof document === 'undefined') return null

  const modalContent = (
    <Box
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0, 0, 0, 0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1200,
      }}
      onClick={onClose}
    >
      <Box
        style={{
          background: tokens.colors.bg.primary,
          borderRadius: tokens.radius.xl,
          padding: tokens.spacing[6],
          width: '90%',
          maxWidth: 400,
          maxHeight: '80vh',
          overflowY: 'auto',
          border: `1px solid ${tokens.colors.border.primary}`,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[4] }}>
          <Text size="lg" weight="bold">收藏到</Text>
          <Box style={{ display: 'flex', gap: tokens.spacing[2] }}>
            <Button
              variant="text"
              size="sm"
              onClick={() => setShowCreateForm(!showCreateForm)}
              style={{ color: tokens.colors.accent?.primary }}
            >
              + 新建收藏夹
            </Button>
            <button
              onClick={onClose}
              style={{
                background: 'transparent',
                border: 'none',
                fontSize: 20,
                cursor: 'pointer',
                color: tokens.colors.text.tertiary,
              }}
            >
              ×
            </button>
          </Box>
        </Box>

        {/* 创建新收藏夹表单 */}
        {showCreateForm && (
          <Box style={{ 
            marginBottom: tokens.spacing[4], 
            padding: tokens.spacing[3],
            background: tokens.colors.bg.secondary,
            borderRadius: tokens.radius.md,
          }}>
            <input
              type="text"
              placeholder="收藏夹名称"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              style={{
                width: '100%',
                padding: tokens.spacing[2],
                borderRadius: tokens.radius.md,
                border: `1px solid ${tokens.colors.border.primary}`,
                background: tokens.colors.bg.primary,
                color: tokens.colors.text.primary,
                marginBottom: tokens.spacing[2],
              }}
            />
            <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], marginBottom: tokens.spacing[2] }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1], cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={newFolderPublic}
                  onChange={(e) => setNewFolderPublic(e.target.checked)}
                  style={{ width: 16, height: 16 }}
                />
                <Text size="sm">公开（取消勾选则为私密）</Text>
              </label>
            </Box>
            <Button
              variant="primary"
              size="sm"
              onClick={createFolder}
              disabled={creating || !newFolderName.trim()}
              style={{ width: '100%' }}
            >
              {creating ? '创建中...' : '创建'}
            </Button>
          </Box>
        )}

        {/* 收藏夹列表 */}
        {loading ? (
          <Text size="sm" color="tertiary" style={{ textAlign: 'center', padding: tokens.spacing[4] }}>
            加载中...
          </Text>
        ) : folders.length === 0 ? (
          <Text size="sm" color="tertiary" style={{ textAlign: 'center', padding: tokens.spacing[4] }}>
            暂无收藏夹
          </Text>
        ) : (
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
            {folders.filter(folder => folder && folder.id && folder.name).map((folder) => (
              <Box
                key={folder.id}
                onClick={() => handleSelectFolder(folder.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: tokens.spacing[3],
                  padding: tokens.spacing[3],
                  borderRadius: tokens.radius.md,
                  cursor: 'pointer',
                  transition: `background ${tokens.transition.base}`,
                  border: `1px solid ${tokens.colors.border.primary}`,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = tokens.colors.bg.secondary
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent'
                }}
              >
                {/* 收藏夹头像 */}
                <Box
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: tokens.radius.md,
                    backgroundColor: folder?.avatar_url ? undefined : getDefaultAvatar(folder?.name || ''),
                    backgroundImage: folder?.avatar_url ? `url(${folder.avatar_url})` : undefined,
                    backgroundSize: 'cover',
                    backgroundPosition: 'center',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  {!folder?.avatar_url && folder?.name && (
                    <Text size="lg" weight="bold" style={{ color: '#fff' }}>
                      {folder.name.charAt(0)}
                    </Text>
                  )}
                </Box>

                {/* 收藏夹信息 */}
                <Box style={{ flex: 1 }}>
                  <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
                    <Text size="sm" weight="semibold">{folder.name}</Text>
                    {folder.is_default && (
                      <span style={{
                        fontSize: 10,
                        padding: '2px 6px',
                        background: tokens.colors.accent?.primary + '20',
                        color: tokens.colors.accent?.primary,
                        borderRadius: tokens.radius.sm,
                      }}>
                        默认
                      </span>
                    )}
                    {folder.is_public && (
                      <span style={{
                        fontSize: 10,
                        padding: '2px 6px',
                        background: '#4ECDC420',
                        color: '#4ECDC4',
                        borderRadius: tokens.radius.sm,
                      }}>
                        公开
                      </span>
                    )}
                  </Box>
                  <Text size="xs" color="tertiary">{folder.post_count || 0} 个收藏</Text>
                </Box>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    </Box>
  )

  return createPortal(modalContent, document.body)
}


