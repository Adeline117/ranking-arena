'use client'

import { useState, useEffect } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '../Base'
import { supabase } from '@/lib/supabase/client'

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
  const [newFolderPublic, setNewFolderPublic] = useState(false)
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
  }, [isOpen, accessToken])

  const loadFolders = async () => {
    if (!accessToken) return
    
    setLoading(true)
    try {
      const response = await fetch('/api/bookmark-folders', {
        headers: {
          'Authorization': `Bearer ${accessToken}`
        }
      })
      const data = await response.json()
      if (response.ok) {
        setFolders(data.folders || [])
      }
    } catch (error) {
      console.error('加载收藏夹失败:', error)
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
          'Authorization': `Bearer ${accessToken}`
        },
        body: JSON.stringify({
          name: newFolderName.trim(),
          is_public: newFolderPublic
        })
      })
      
      const data = await response.json()
      if (response.ok) {
        setFolders(prev => [...prev, data.folder])
        setNewFolderName('')
        setNewFolderPublic(false)
        setShowCreateForm(false)
      } else {
        alert(data.error || '创建失败')
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

  if (!isOpen) return null

  return (
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
        zIndex: 3000,
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
                <Text size="sm">公开（在主页展示）</Text>
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
            {folders.map((folder) => (
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
                    background: folder.avatar_url ? `url(${folder.avatar_url})` : getDefaultAvatar(folder.name),
                    backgroundSize: 'cover',
                    backgroundPosition: 'center',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  {!folder.avatar_url && (
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
                  <Text size="xs" color="tertiary">{folder.post_count} 个收藏</Text>
                </Box>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    </Box>
  )
}

