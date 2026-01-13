'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/Layout/TopNav'
import { Box, Text, Button } from '@/app/components/Base'
import Card from '@/app/components/UI/Card'

// 管理员邮箱白名单（可以移到环境变量或数据库）
const ADMIN_EMAILS: string[] = [
  // 添加管理员邮箱，例如: 'admin@example.com'
]

export default function AdminPage() {
  const router = useRouter()
  const [rows, setRows] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [email, setEmail] = useState<string | null>(null)
  const [isAdmin, setIsAdmin] = useState(false)
  const [authChecking, setAuthChecking] = useState(true)

  useEffect(() => {
    checkAuth()
  }, [])

  async function checkAuth() {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      
      if (!user) {
        router.push('/login?redirect=/admin')
        return
      }

      setEmail(user.email ?? null)
      
      // 检查是否是管理员
      // 方法1: 邮箱白名单
      const isAdminByEmail = user.email && ADMIN_EMAILS.includes(user.email)
      
      // 方法2: 检查数据库中的 admin 角色
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('role')
        .eq('id', user.id)
        .maybeSingle()
      
      const isAdminByRole = profile?.role === 'admin'
      
      if (!isAdminByEmail && !isAdminByRole) {
        // 不是管理员，重定向到首页
        router.push('/')
        return
      }
      
      setIsAdmin(true)
      setAuthChecking(false)
      load()
    } catch (error) {
      console.error('Auth check failed:', error)
      router.push('/login')
    }
  }

  async function load() {
    setLoading(true)

    const { data } = await supabase
      .from('trader_snapshots')
      .select('source, source_trader_id, roi, win_rate, followers, captured_at')
      .order('roi', { ascending: false })
      .limit(50)

    setRows(data || [])
    setLoading(false)
  }

  if (authChecking) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6] }}>
          <Text size="lg">验证权限中...</Text>
        </Box>
      </Box>
    )
  }

  if (!isAdmin) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6], textAlign: 'center' }}>
          <Text size="2xl" weight="black" style={{ marginBottom: tokens.spacing[4] }}>
            🚫 无权限访问
          </Text>
          <Text color="tertiary" style={{ marginBottom: tokens.spacing[4] }}>
            您没有管理员权限，无法访问此页面
          </Text>
          <Button variant="primary" onClick={() => router.push('/')}>
            返回首页
          </Button>
        </Box>
      </Box>
    )
  }

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />
      
      <Box style={{ maxWidth: 1400, margin: '0 auto', padding: tokens.spacing[6] }}>
        <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[6] }}>
          <Text size="2xl" weight="black">
            🔐 管理后台
          </Text>
          <Button variant="secondary" onClick={load} disabled={loading}>
            {loading ? '刷新中...' : '刷新数据'}
          </Button>
        </Box>

        <Card title="交易员快照数据 (Top 50)">
          {loading ? (
            <Box style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
              <Text color="tertiary">加载中...</Text>
            </Box>
          ) : (
            <Box style={{ overflowX: 'auto' }}>
              <table style={{ 
                width: '100%', 
                borderCollapse: 'collapse',
                fontSize: tokens.typography.fontSize.sm,
              }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${tokens.colors.border.primary}` }}>
                    <th style={{ padding: tokens.spacing[3], textAlign: 'left', fontWeight: tokens.typography.fontWeight.bold, color: tokens.colors.text.secondary }}>
                      来源
                    </th>
                    <th style={{ padding: tokens.spacing[3], textAlign: 'left', fontWeight: tokens.typography.fontWeight.bold, color: tokens.colors.text.secondary }}>
                      交易员 ID
                    </th>
                    <th style={{ padding: tokens.spacing[3], textAlign: 'right', fontWeight: tokens.typography.fontWeight.bold, color: tokens.colors.text.secondary }}>
                      ROI (90D)
                    </th>
                    <th style={{ padding: tokens.spacing[3], textAlign: 'right', fontWeight: tokens.typography.fontWeight.bold, color: tokens.colors.text.secondary }}>
                      胜率
                    </th>
                    <th style={{ padding: tokens.spacing[3], textAlign: 'right', fontWeight: tokens.typography.fontWeight.bold, color: tokens.colors.text.secondary }}>
                      粉丝数
                    </th>
                    <th style={{ padding: tokens.spacing[3], textAlign: 'left', fontWeight: tokens.typography.fontWeight.bold, color: tokens.colors.text.secondary }}>
                      采集时间
                    </th>
                  </tr>
                </thead>

                <tbody>
                  {rows.map((r, idx) => (
                    <tr 
                      key={`${r.source}-${r.source_trader_id}-${idx}`}
                      style={{ 
                        borderBottom: `1px solid ${tokens.colors.border.primary}`,
                        background: idx % 2 === 0 ? 'transparent' : tokens.colors.bg.secondary,
                      }}
                    >
                      <td style={{ padding: tokens.spacing[3] }}>
                        <Box
                          style={{
                            display: 'inline-block',
                            padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                            borderRadius: tokens.radius.sm,
                            background: tokens.colors.bg.tertiary,
                            fontSize: tokens.typography.fontSize.xs,
                            fontWeight: tokens.typography.fontWeight.bold,
                            textTransform: 'uppercase',
                          }}
                        >
                          {String(r.source || '')}
                        </Box>
                      </td>
                      <td style={{ padding: tokens.spacing[3], fontFamily: 'monospace', fontSize: tokens.typography.fontSize.xs }}>
                        {r.source_trader_id?.slice(0, 16)}...
                      </td>
                      <td style={{ 
                        padding: tokens.spacing[3], 
                        textAlign: 'right',
                        color: (r.roi || 0) >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error,
                        fontWeight: tokens.typography.fontWeight.bold,
                      }}>
                        {r.roi != null ? `${r.roi >= 0 ? '+' : ''}${r.roi.toFixed(2)}%` : '-'}
                      </td>
                      <td style={{ padding: tokens.spacing[3], textAlign: 'right' }}>
                        {r.win_rate != null ? `${r.win_rate.toFixed(1)}%` : '-'}
                      </td>
                      <td style={{ padding: tokens.spacing[3], textAlign: 'right' }}>
                        {r.followers?.toLocaleString() || '-'}
                      </td>
                      <td style={{ padding: tokens.spacing[3], fontSize: tokens.typography.fontSize.xs, color: tokens.colors.text.tertiary }}>
                        {r.captured_at ? new Date(r.captured_at).toLocaleString() : '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Box>
          )}
        </Card>
      </Box>
    </Box>
  )
}
