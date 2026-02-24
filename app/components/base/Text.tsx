
import React from 'react'
import { tokens } from '@/lib/design-tokens'

export interface TextProps extends React.HTMLAttributes<HTMLElement> {
  as?: 'p' | 'span' | 'div' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
  size?: keyof typeof tokens.typography.fontSize
  weight?: keyof typeof tokens.typography.fontWeight
  color?: 'primary' | 'secondary' | 'tertiary' | 'disabled'
  lineHeight?: keyof typeof tokens.typography.lineHeight
}

export default function Text({
  as: Component = 'p',
  size = 'base',
  weight = 'normal',
  color = 'primary',
  lineHeight = 'normal',
  style,
  children,
  ...props
}: TextProps) {
  const styles: React.CSSProperties = {
    fontSize: tokens.typography.fontSize[size],
    fontWeight: tokens.typography.fontWeight[weight],
    color: tokens.colors.text[color],
    lineHeight: tokens.typography.lineHeight[lineHeight],
    margin: 0,
    ...style,
  }

  return (
    <Component style={styles} {...props}>
      {children}
    </Component>
  )
}

