'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import { supabase } from '@/lib/supabase/client'
import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { getAvatarGradient, getAvatarInitial } from '@/lib/utils/avatar'

export default function FollowersList({ profileId }: { profileId: string }) {
  const { t } = useLanguage()
  const [followers, setFollowers] = useState<Array<{ id: string; handle: string; avatar_url: string | null }>>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      setLoading(true)
      try {
        const { data: follows } = await supabase
          .from('user_follows')
          .select('follower_id')
          .eq('following_id', profileId)
          .limit(100)
        if (follows && follows.length > 0) {
          const ids = follows.map((f: { follower_id: string }) => f.follower_id)
          const { data: profiles } = await supabase
            .from('user_profiles')
            .select('id, handle, avatar_url')
            .in('id', ids)
          setFollowers((profiles || []) as Array<{ id: string; handle: string; avatar_url: string | null }>)
        } else {
          setFollowers([])
        }
      } catch {
        setFollowers([])
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [profileId])

  if (loading) {
    return (
      <Box style={{ padding: tokens.spacing[6], textAlign: 'center' }}>
        <Text size="sm" color="tertiary">{t('loading') || '...'}</Text>
      </Box>
    )
  }

  if (followers.length === 0) {
    return (
      <Box bg="secondary" p={6} radius="lg" border="primary" style={{ textAlign: 'center' }}>
        <Text size="sm" color="tertiary">{t('noFollowers') || 'No followers yet'}</Text>
      </Box>
    )
  }

  return (
    <Box bg="secondary" p={4} radius="lg" border="primary">
      <Text size="lg" weight="black" style={{ marginBottom: tokens.spacing[4] }}>
        {t('followers') || 'Followers'} ({followers.length})
      </Text>
      <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
        {followers.map(f => (
          <Link key={f.id} href={`/u/${encodeURIComponent(f.handle)}`} style={{ textDecoration: 'none' }}>
            <Box style={{
              display: 'flex', alignItems: 'center', gap: tokens.spacing[3],
              padding: tokens.spacing[3], borderRadius: tokens.radius.md,
              transition: 'background 0.15s',
            }}
              onMouseEnter={e => { e.currentTarget.style.background = tokens.colors.bg.tertiary }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
            >
              <Box style={{
                width: 40, height: 40, borderRadius: tokens.radius.full,
                background: f.avatar_url ? tokens.colors.bg.tertiary : getAvatarGradient(f.id),
                overflow: 'hidden', display: 'grid', placeItems: 'center', flexShrink: 0,
              }}>
                {f.avatar_url ? (
                  <Image src={`/api/avatar?url=${encodeURIComponent(f.avatar_url)}`} alt={f.handle} width={40} height={40} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <Text size="sm" weight="bold" style={{ color: tokens.colors.white }}>{getAvatarInitial(f.handle)}</Text>
                )}
              </Box>
              <Text size="sm" weight="semibold" style={{ color: tokens.colors.text.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, maxWidth: 180 }}>
                @{f.handle}
              </Text>
            </Box>
          </Link>
        ))}
      </Box>
    </Box>
  )
}
