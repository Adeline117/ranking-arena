'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/Layout/TopNav'
import { Box, Text, Button } from '@/app/components/Base'
import Avatar from '@/app/components/UI/Avatar'

export default function SettingsPage() {
  const router = useRouter()
  const [email, setEmail] = useState<string | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  
  // Profile data
  const [handle, setHandle] = useState('')
  const [bio, setBio] = useState('')
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)
  const [avatarFile, setAvatarFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  
  // Account bindings
  const [binanceId, setBinanceId] = useState('')
  const [bybitId, setBybitId] = useState('')
  const [walletAddress, setWalletAddress] = useState('')

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
      setUserId(data.user?.id ?? null)
      
      if (!data.user) {
        router.push('/login')
        return
      }
      
      // Load profile
      loadProfile(data.user.id)
    })
  }, [router])

  const loadProfile = async (uid: string) => {
    try {
      setLoading(true)
      
      // 只使用 user_profiles（避免访问不存在的 profiles 表）
      const { data: userProfile } = await supabase
        .from('user_profiles')
        .select('handle, bio, avatar_url')
        .eq('id', uid)
        .maybeSingle()
      
      if (userProfile) {
        setHandle(userProfile.handle || '')
        setBio(userProfile.bio || '')
        setAvatarUrl(userProfile.avatar_url || null)
        setPreviewUrl(userProfile.avatar_url || null)
      }

      // Load account bindings
      const { data: bindings } = await supabase
        .from('account_bindings')
        .select('platform, account_id')
        .eq('user_id', uid)
      
      if (bindings) {
        bindings.forEach((binding: any) => {
          if (binding.platform === 'binance') setBinanceId(binding.account_id || '')
          if (binding.platform === 'bybit') setBybitId(binding.account_id || '')
          if (binding.platform === 'wallet') setWalletAddress(binding.account_id || '')
        })
      }
    } catch (error) {
      console.error('Error loading profile:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      setAvatarFile(file)
      const reader = new FileReader()
      reader.onloadend = () => {
        setPreviewUrl(reader.result as string)
      }
      reader.readAsDataURL(file)
    }
  }

  const uploadAvatar = async (file: File, userId: string): Promise<string | null> => {
    try {
      const fileExt = file.name.split('.').pop()
      const fileName = `${userId}-${Date.now()}.${fileExt}`
      const filePath = `avatars/${fileName}`

      const { error: uploadError } = await supabase.storage
        .from('avatars')
        .upload(filePath, file, { upsert: true })

      if (uploadError) {
        console.error('Upload error:', uploadError)
        return null
      }

      const { data } = supabase.storage.from('avatars').getPublicUrl(filePath)
      return data.publicUrl
    } catch (error) {
      console.error('Error uploading avatar:', error)
      return null
    }
  }

  const handleSave = async () => {
    if (!userId) return
    
    setSaving(true)
    try {
      let finalAvatarUrl = avatarUrl
      
      // Upload avatar if changed
      if (avatarFile) {
        const uploadedUrl = await uploadAvatar(avatarFile, userId)
        if (uploadedUrl) {
          finalAvatarUrl = uploadedUrl
        }
      }
      
      // Update profile in user_profiles
      const { error: userProfilesError } = await supabase
        .from('user_profiles')
        .upsert(
          {
            id: userId,
            handle: handle || null,
            bio: bio || null,
            avatar_url: finalAvatarUrl || null,
          },
          { onConflict: 'id' }
        )
      
      if (userProfilesError) {
        console.error('Error saving profile:', userProfilesError)
        alert('保存失败，请重试')
        return
      }
      
      // Save account bindings
      const bindings = []
      if (binanceId) bindings.push({ user_id: userId, platform: 'binance', account_id: binanceId })
      if (bybitId) bindings.push({ user_id: userId, platform: 'bybit', account_id: bybitId })
      if (walletAddress) bindings.push({ user_id: userId, platform: 'wallet', account_id: walletAddress })
      
      if (bindings.length > 0) {
        // Delete old bindings and insert new ones
        await supabase.from('account_bindings').delete().eq('user_id', userId)
        await supabase.from('account_bindings').insert(bindings)
      }
      
      alert('保存成功！')
      router.push(`/u/${handle || userId}`)
    } catch (error) {
      console.error('Error saving:', error)
      alert('保存失败，请重试')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box style={{ maxWidth: 800, margin: '0 auto', padding: tokens.spacing[6] }}>
          <Text size="lg">加载中...</Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />
      
      <Box style={{ maxWidth: 800, margin: '0 auto', padding: tokens.spacing[6] }}>
        <Text size="2xl" weight="black" style={{ marginBottom: tokens.spacing[6] }}>
          编辑个人资料
        </Text>

        {/* Avatar Section */}
        <Box
          bg="secondary"
          p={6}
          radius="xl"
          border="primary"
          style={{ marginBottom: tokens.spacing[6] }}
        >
          <Text size="lg" weight="black" style={{ marginBottom: tokens.spacing[4] }}>
            头像
          </Text>
          
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[4] }}>
            {userId ? (
              <Avatar
                userId={userId}
                name={handle || email}
                avatarUrl={previewUrl}
                size={100}
                style={{
                  borderRadius: tokens.radius.xl,
                  border: `1px solid ${tokens.colors.border.primary}`,
                }}
              />
            ) : (
              <Box
                style={{
                  width: 100,
                  height: 100,
                  borderRadius: tokens.radius.xl,
                  background: tokens.colors.bg.tertiary,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  display: 'grid',
                  placeItems: 'center',
                  overflow: 'hidden',
                  flexShrink: 0,
                }}
              >
                <Text size="3xl" weight="black" style={{ color: tokens.colors.text.secondary }}>
                  {(handle?.[0] || email?.[0] || 'U').toUpperCase()}
                </Text>
              </Box>
            )}
            
            <Box>
              <input
                type="file"
                accept="image/*"
                onChange={handleAvatarChange}
                style={{ display: 'none' }}
                id="avatar-input"
              />
              <label
                htmlFor="avatar-input"
                style={{
                  display: 'inline-block',
                  padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  background: tokens.colors.bg.secondary,
                  color: tokens.colors.text.primary,
                  cursor: 'pointer',
                  fontWeight: tokens.typography.fontWeight.bold,
                  fontSize: tokens.typography.fontSize.sm,
                }}
              >
                选择图片
              </label>
              <Text size="xs" color="tertiary" style={{ marginTop: tokens.spacing[1], display: 'block' }}>
                支持 JPG、PNG 格式，最大 5MB
              </Text>
            </Box>
          </Box>
        </Box>

        {/* Handle Section */}
        <Box
          bg="secondary"
          p={6}
          radius="xl"
          border="primary"
          style={{ marginBottom: tokens.spacing[6] }}
        >
          <Text size="lg" weight="black" style={{ marginBottom: tokens.spacing[4] }}>
            用户名
          </Text>
          <input
            type="text"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            placeholder="输入用户名"
            style={{
              width: '100%',
              padding: tokens.spacing[3],
              borderRadius: tokens.radius.md,
              border: `1px solid ${tokens.colors.border.primary}`,
              background: tokens.colors.bg.primary,
              color: tokens.colors.text.primary,
              fontSize: tokens.typography.fontSize.base,
              fontFamily: tokens.typography.fontFamily.sans.join(', '),
              outline: 'none',
            }}
          />
        </Box>

        {/* Bio Section */}
        <Box
          bg="secondary"
          p={6}
          radius="xl"
          border="primary"
          style={{ marginBottom: tokens.spacing[6] }}
        >
          <Text size="lg" weight="black" style={{ marginBottom: tokens.spacing[4] }}>
            个人简介
          </Text>
          <textarea
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            placeholder="介绍一下自己..."
            rows={6}
            style={{
              width: '100%',
              padding: tokens.spacing[3],
              borderRadius: tokens.radius.md,
              border: `1px solid ${tokens.colors.border.primary}`,
              background: tokens.colors.bg.primary,
              color: tokens.colors.text.primary,
              fontSize: tokens.typography.fontSize.base,
              fontFamily: tokens.typography.fontFamily.sans.join(', '),
              outline: 'none',
              resize: 'vertical',
            }}
          />
        </Box>

        {/* Account Bindings Section */}
        <Box
          bg="secondary"
          p={6}
          radius="xl"
          border="primary"
          style={{ marginBottom: tokens.spacing[6] }}
        >
          <Text size="lg" weight="black" style={{ marginBottom: tokens.spacing[4] }}>
            绑定交易账号
          </Text>
          <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[4] }}>
            绑定您的交易账号后，如果该账号在排行榜上，系统将自动合并账号
          </Text>
          
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
            <Box>
              <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2], display: 'block' }}>
                Binance 账号ID
              </Text>
              <input
                type="text"
                value={binanceId}
                onChange={(e) => setBinanceId(e.target.value)}
                placeholder="输入您的 Binance 账号ID"
                style={{
                  width: '100%',
                  padding: tokens.spacing[3],
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  background: tokens.colors.bg.primary,
                  color: tokens.colors.text.primary,
                  fontSize: tokens.typography.fontSize.base,
                  fontFamily: tokens.typography.fontFamily.sans.join(', '),
                  outline: 'none',
                }}
              />
            </Box>
            
            <Box>
              <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2], display: 'block' }}>
                Bybit 账号ID
              </Text>
              <input
                type="text"
                value={bybitId}
                onChange={(e) => setBybitId(e.target.value)}
                placeholder="输入您的 Bybit 账号ID"
                style={{
                  width: '100%',
                  padding: tokens.spacing[3],
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  background: tokens.colors.bg.primary,
                  color: tokens.colors.text.primary,
                  fontSize: tokens.typography.fontSize.base,
                  fontFamily: tokens.typography.fontFamily.sans.join(', '),
                  outline: 'none',
                }}
              />
            </Box>
            
            <Box>
              <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2], display: 'block' }}>
                钱包地址
              </Text>
              <input
                type="text"
                value={walletAddress}
                onChange={(e) => setWalletAddress(e.target.value)}
                placeholder="输入您的钱包地址（0x...）"
                style={{
                  width: '100%',
                  padding: tokens.spacing[3],
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  background: tokens.colors.bg.primary,
                  color: tokens.colors.text.primary,
                  fontSize: tokens.typography.fontSize.base,
                  fontFamily: tokens.typography.fontFamily.sans.join(', '),
                  outline: 'none',
                }}
              />
            </Box>
          </Box>
        </Box>

        {/* Save Button */}
        <Box style={{ display: 'flex', justifyContent: 'flex-end', gap: tokens.spacing[3] }}>
          <Button
            variant="secondary"
            onClick={() => router.back()}
            disabled={saving}
          >
            取消
          </Button>
          <Button
            variant="primary"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? '保存中...' : '保存'}
          </Button>
        </Box>
      </Box>
    </Box>
  )
}


