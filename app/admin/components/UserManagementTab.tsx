'use client'

import { useEffect, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/Base'
import Card from '@/app/components/UI/Card'
import { useUsers } from '../hooks/useUsers'

interface UserManagementTabProps {
  accessToken: string | null
}

export default function UserManagementTab({ accessToken }: UserManagementTabProps) {
  const {
    users,
    pagination,
    loading,
    actionLoading,
    loadUsers,
    banUser,
    unbanUser,
  } = useUsers(accessToken)

  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | 'banned' | 'active'>('all')
  const [showBanInput, setShowBanInput] = useState<Record<string, boolean>>({})
  const [banReason, setBanReason] = useState<Record<string, string>>({})

  useEffect(() => {
    if (accessToken) {
      loadUsers(1, search, filter)
    }
  }, [accessToken, loadUsers, filter])

  const handleSearch = () => {
    loadUsers(1, search, filter)
  }

  const handlePageChange = (page: number) => {
    loadUsers(page, search, filter)
  }

  const handleBan = async (userId: string) => {
    const reason = banReason[userId]?.trim()
    const success = await banUser(userId, reason)
    if (success) {
      setShowBanInput(prev => ({ ...prev, [userId]: false }))
      setBanReason(prev => ({ ...prev, [userId]: '' }))
    }
  }

  return (
    <Card title="用户管理">
      {/* Search and Filter */}
      <Box style={{ marginBottom: tokens.spacing[4], display: 'flex', gap: tokens.spacing[3], flexWrap: 'wrap' }}>
        <Box style={{ display: 'flex', gap: tokens.spacing[2], flex: 1, minWidth: 200 }}>
          <input
            type="text"
            placeholder="搜索用户名或邮箱..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            style={{
              flex: 1,
              padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
              borderRadius: tokens.radius.md,
              border: `1px solid ${tokens.colors.border.primary}`,
              background: tokens.colors.bg.primary,
              color: tokens.colors.text.primary,
              fontSize: tokens.typography.fontSize.sm,
            }}
          />
          <Button variant="secondary" size="sm" onClick={handleSearch}>
            搜索
          </Button>
        </Box>
        
        <Box style={{ display: 'flex', gap: tokens.spacing[2] }}>
          {(['all', 'active', 'banned'] as const).map((f) => (
            <Button
              key={f}
              variant={filter === f ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => setFilter(f)}
            >
              {f === 'all' ? '全部' : f === 'active' ? '正常' : '已封禁'}
            </Button>
          ))}
        </Box>
      </Box>

      {/* User List */}
      {loading ? (
        <Box style={{ padding: tokens.spacing[8], textAlign: 'center' }}>
          <Text color="tertiary">加载中...</Text>
        </Box>
      ) : users.length === 0 ? (
        <Box style={{ padding: tokens.spacing[8], textAlign: 'center' }}>
          <Text color="tertiary">暂无用户</Text>
        </Box>
      ) : (
        <>
          <Box style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: tokens.typography.fontSize.sm }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${tokens.colors.border.primary}` }}>
                  <th style={{ padding: tokens.spacing[3], textAlign: 'left', color: tokens.colors.text.tertiary }}>用户</th>
                  <th style={{ padding: tokens.spacing[3], textAlign: 'left', color: tokens.colors.text.tertiary }}>邮箱</th>
                  <th style={{ padding: tokens.spacing[3], textAlign: 'center', color: tokens.colors.text.tertiary }}>粉丝/关注</th>
                  <th style={{ padding: tokens.spacing[3], textAlign: 'center', color: tokens.colors.text.tertiary }}>状态</th>
                  <th style={{ padding: tokens.spacing[3], textAlign: 'left', color: tokens.colors.text.tertiary }}>注册时间</th>
                  <th style={{ padding: tokens.spacing[3], textAlign: 'right', color: tokens.colors.text.tertiary }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user, idx) => (
                  <tr
                    key={user.id}
                    style={{
                      borderBottom: `1px solid ${tokens.colors.border.primary}`,
                      background: idx % 2 === 0 ? 'transparent' : tokens.colors.bg.secondary,
                    }}
                  >
                    <td style={{ padding: tokens.spacing[3] }}>
                      <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
                        <Box
                          style={{
                            width: 32,
                            height: 32,
                            borderRadius: '50%',
                            background: tokens.colors.bg.tertiary,
                            overflow: 'hidden',
                            flexShrink: 0,
                          }}
                        >
                          {user.avatar_url ? (
                            <img
                              src={user.avatar_url}
                              alt=""
                              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                            />
                          ) : (
                            <Box
                              style={{
                                width: '100%',
                                height: '100%',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                              }}
                            >
                              <Text size="sm" color="tertiary">
                                {(user.handle || '?')[0].toUpperCase()}
                              </Text>
                            </Box>
                          )}
                        </Box>
                        <Box>
                          <Text size="sm" weight="bold">
                            @{user.handle || 'unnamed'}
                          </Text>
                          {user.role === 'admin' && (
                            <Text size="xs" style={{ color: tokens.colors.accent.primary }}>
                              管理员
                            </Text>
                          )}
                        </Box>
                      </Box>
                    </td>
                    <td style={{ padding: tokens.spacing[3] }}>
                      <Text size="sm" color="secondary">{user.email || '-'}</Text>
                    </td>
                    <td style={{ padding: tokens.spacing[3], textAlign: 'center' }}>
                      <Text size="sm" color="secondary">
                        {user.follower_count} / {user.following_count}
                      </Text>
                    </td>
                    <td style={{ padding: tokens.spacing[3], textAlign: 'center' }}>
                      {user.banned_at ? (
                        <Box
                          style={{
                            display: 'inline-block',
                            padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                            borderRadius: tokens.radius.sm,
                            background: tokens.colors.accent.error,
                            color: '#fff',
                            fontSize: tokens.typography.fontSize.xs,
                          }}
                        >
                          已封禁
                        </Box>
                      ) : (
                        <Box
                          style={{
                            display: 'inline-block',
                            padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                            borderRadius: tokens.radius.sm,
                            background: tokens.colors.accent.success,
                            color: '#fff',
                            fontSize: tokens.typography.fontSize.xs,
                          }}
                        >
                          正常
                        </Box>
                      )}
                    </td>
                    <td style={{ padding: tokens.spacing[3] }}>
                      <Text size="xs" color="tertiary">
                        {new Date(user.created_at).toLocaleDateString('zh-CN')}
                      </Text>
                    </td>
                    <td style={{ padding: tokens.spacing[3], textAlign: 'right' }}>
                      {user.banned_at ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => unbanUser(user.id)}
                          disabled={actionLoading[user.id]}
                        >
                          {actionLoading[user.id] ? '处理中...' : '解封'}
                        </Button>
                      ) : showBanInput[user.id] ? (
                        <Box style={{ display: 'flex', gap: tokens.spacing[2], justifyContent: 'flex-end' }}>
                          <input
                            type="text"
                            placeholder="封禁原因（可选）"
                            value={banReason[user.id] || ''}
                            onChange={(e) => setBanReason(prev => ({ ...prev, [user.id]: e.target.value }))}
                            style={{
                              width: 150,
                              padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                              borderRadius: tokens.radius.sm,
                              border: `1px solid ${tokens.colors.border.primary}`,
                              background: tokens.colors.bg.primary,
                              color: tokens.colors.text.primary,
                              fontSize: tokens.typography.fontSize.xs,
                            }}
                          />
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => handleBan(user.id)}
                            disabled={actionLoading[user.id]}
                            style={{ background: tokens.colors.accent.error, color: '#fff' }}
                          >
                            确认
                          </Button>
                          <Button
                            variant="text"
                            size="sm"
                            onClick={() => setShowBanInput(prev => ({ ...prev, [user.id]: false }))}
                          >
                            取消
                          </Button>
                        </Box>
                      ) : (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => setShowBanInput(prev => ({ ...prev, [user.id]: true }))}
                          disabled={user.role === 'admin'}
                        >
                          封禁
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Box>

          {/* Pagination */}
          {pagination.totalPages > 1 && (
            <Box style={{ marginTop: tokens.spacing[4], display: 'flex', justifyContent: 'center', gap: tokens.spacing[2] }}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => handlePageChange(pagination.page - 1)}
                disabled={pagination.page <= 1}
              >
                上一页
              </Button>
              <Text size="sm" color="secondary" style={{ display: 'flex', alignItems: 'center' }}>
                {pagination.page} / {pagination.totalPages}
              </Text>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => handlePageChange(pagination.page + 1)}
                disabled={pagination.page >= pagination.totalPages}
              >
                下一页
              </Button>
            </Box>
          )}
        </>
      )}
    </Card>
  )
}
