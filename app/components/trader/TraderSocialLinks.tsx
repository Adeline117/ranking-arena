'use client'

import { tokens } from '@/lib/design-tokens'
import { Box } from '../base'

export interface SocialLinks {
  twitter?: string
  telegram?: string
  discord?: string
  github?: string
  website?: string
}

const socialLinkStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
  borderRadius: tokens.radius.md,
  background: `${tokens.colors.bg.tertiary}80`,
  color: tokens.colors.text.secondary,
  fontSize: tokens.typography.fontSize.xs,
  textDecoration: 'none',
  transition: `all ${tokens.transition.base}`,
  border: `1px solid ${tokens.colors.border.primary}40`,
}

function SocialLink({
  href,
  icon,
  text,
  title,
}: {
  href?: string
  icon: string
  text: string
  title: string
}): React.ReactElement {
  const content = (
    <>
      <span style={{ fontSize: tokens.typography.fontSize.xs }}>{icon}</span>
      <span>{text}</span>
    </>
  )

  if (href) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" title={title} style={socialLinkStyle}>
        {content}
      </a>
    )
  }

  return (
    <span title={title} style={socialLinkStyle}>
      {content}
    </span>
  )
}

export interface TraderSocialLinksProps {
  socialLinks: SocialLinks
}

/**
 * Renders a row of social link chips (Twitter, Telegram, Discord, GitHub, Website).
 */
export function TraderSocialLinksSection({ socialLinks }: TraderSocialLinksProps) {
  if (!Object.values(socialLinks).some(v => v)) return null

  return (
    <Box
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: tokens.spacing[2],
        justifyContent: 'center',
        marginBottom: tokens.spacing[4],
        position: 'relative',
        zIndex: 1,
      }}
    >
      {socialLinks.twitter && (
        <SocialLink
          href={`https://x.com/${socialLinks.twitter}`}
          icon="\u{1D54F}"
          text={socialLinks.twitter}
          title={`@${socialLinks.twitter}`}
        />
      )}
      {socialLinks.telegram && (
        <SocialLink
          href={`https://t.me/${socialLinks.telegram}`}
          icon="TG"
          text={socialLinks.telegram}
          title={`@${socialLinks.telegram}`}
        />
      )}
      {socialLinks.discord && (
        <SocialLink
          icon="DC"
          text={socialLinks.discord.length > 12 ? socialLinks.discord.slice(0, 12) + '...' : socialLinks.discord}
          title={socialLinks.discord}
        />
      )}
      {socialLinks.github && (
        <SocialLink
          href={`https://github.com/${socialLinks.github}`}
          icon="GH"
          text={socialLinks.github}
          title={socialLinks.github}
        />
      )}
      {socialLinks.website && (
        <SocialLink
          href={socialLinks.website.startsWith('http') ? socialLinks.website : `https://${socialLinks.website}`}
          icon="W"
          text={socialLinks.website.replace(/^https?:\/\//, '').slice(0, 20)}
          title={socialLinks.website}
        />
      )}
    </Box>
  )
}
