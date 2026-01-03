'use client'

import React, { useState } from 'react'
import { cardStyle, cardHoverStyle } from '@/lib/design-system-helpers'

export default function Card(props: { 
  title: string
  children: React.ReactNode
  hoverable?: boolean
  className?: string
}) {
  const [isHovered, setIsHovered] = useState(false)
  const { hoverable = false } = props

  const style = hoverable && isHovered ? cardHoverStyle : cardStyle

  return (
    <div 
      style={style}
      className={props.className}
      onMouseEnter={() => hoverable && setIsHovered(true)}
      onMouseLeave={() => hoverable && setIsHovered(false)}
    >
      <div style={{ fontWeight: 950, fontSize: '16px', marginBottom: '12px', color: '#f2f2f2' }}>
        {props.title}
      </div>
      {props.children}
    </div>
  )
}
