'use client'

import React from 'react'
import { tokens } from '@/lib/design-tokens'

export interface BoxProps extends React.HTMLAttributes<HTMLDivElement> {
  as?: React.ElementType
  p?: keyof typeof tokens.spacing
  px?: keyof typeof tokens.spacing
  py?: keyof typeof tokens.spacing
  pt?: keyof typeof tokens.spacing
  pr?: keyof typeof tokens.spacing
  pb?: keyof typeof tokens.spacing
  pl?: keyof typeof tokens.spacing
  m?: keyof typeof tokens.spacing
  mx?: keyof typeof tokens.spacing
  my?: keyof typeof tokens.spacing
  mt?: keyof typeof tokens.spacing
  mr?: keyof typeof tokens.spacing
  mb?: keyof typeof tokens.spacing
  ml?: keyof typeof tokens.spacing
  gap?: keyof typeof tokens.spacing
  bg?: 'primary' | 'secondary' | 'tertiary' | 'hover'
  radius?: keyof typeof tokens.radius
  border?: 'primary' | 'secondary' | 'focus' | 'none'
}

export default function Box({
  as: Component = 'div',
  p,
  px,
  py,
  pt,
  pr,
  pb,
  pl,
  m,
  mx,
  my,
  mt,
  mr,
  mb,
  ml,
  gap,
  bg,
  radius,
  border = 'none',
  style,
  children,
  ...props
}: BoxProps) {
  const styles: React.CSSProperties = {
    ...(p && { padding: tokens.spacing[p] }),
    ...(px && { paddingLeft: tokens.spacing[px], paddingRight: tokens.spacing[px] }),
    ...(py && { paddingTop: tokens.spacing[py], paddingBottom: tokens.spacing[py] }),
    ...(pt && { paddingTop: tokens.spacing[pt] }),
    ...(pr && { paddingRight: tokens.spacing[pr] }),
    ...(pb && { paddingBottom: tokens.spacing[pb] }),
    ...(pl && { paddingLeft: tokens.spacing[pl] }),
    ...(m && { margin: tokens.spacing[m] }),
    ...(mx && { marginLeft: tokens.spacing[mx], marginRight: tokens.spacing[mx] }),
    ...(my && { marginTop: tokens.spacing[my], marginBottom: tokens.spacing[my] }),
    ...(mt && { marginTop: tokens.spacing[mt] }),
    ...(mr && { marginRight: tokens.spacing[mr] }),
    ...(mb && { marginBottom: tokens.spacing[mb] }),
    ...(ml && { marginLeft: tokens.spacing[ml] }),
    ...(gap && { gap: tokens.spacing[gap] }),
    ...(bg && { background: tokens.colors.bg[bg] }),
    ...(radius && { borderRadius: tokens.radius[radius] }),
    ...(border !== 'none' && {
      border: `1px solid ${tokens.colors.border[border]}`,
    }),
    ...style,
  }

  return (
    <Component style={styles} {...(props as any)}>
      {children}
    </Component>
  )
}

