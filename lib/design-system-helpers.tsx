/**
 * Design System Helper Components
 * 设计系统辅助组件和工具函数
 */

import React from 'react'

// 通用卡片样式
export const cardStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: '16px',
  padding: '16px',
  transition: 'all 200ms ease',
}

export const cardHoverStyle: React.CSSProperties = {
  ...cardStyle,
  background: 'rgba(255,255,255,0.05)',
  borderColor: 'rgba(255,255,255,0.12)',
  transform: 'translateY(-2px)',
  boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
}

// 按钮样式
export const buttonPrimaryStyle: React.CSSProperties = {
  background: '#8b6fa8',
  color: '#fff',
  border: 'none',
  borderRadius: '12px',
  padding: '10px 16px',
  fontWeight: 900,
  fontSize: '14px',
  cursor: 'pointer',
  transition: 'all 200ms ease',
}

export const buttonSecondaryStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.05)',
  color: 'rgba(255,255,255,0.86)',
  border: '1px solid rgba(255,255,255,0.14)',
  borderRadius: '12px',
  padding: '10px 16px',
  fontWeight: 900,
  fontSize: '14px',
  cursor: 'pointer',
  transition: 'all 200ms ease',
}

export const buttonGhostStyle: React.CSSProperties = {
  background: 'transparent',
  color: 'rgba(255,255,255,0.7)',
  border: 'none',
  borderRadius: '8px',
  padding: '6px 12px',
  fontWeight: 700,
  fontSize: '13px',
  cursor: 'pointer',
  transition: 'all 200ms ease',
}

// 输入框样式
export const inputStyle: React.CSSProperties = {
  background: '#0b0b0b',
  border: '1px solid #1f1f1f',
  borderRadius: '12px',
  padding: '10px 14px',
  color: '#eaeaea',
  fontSize: '14px',
  outline: 'none',
  transition: 'all 200ms ease',
  width: '100%',
}

// 工具函数：格式化数字
export function formatNumber(num: number): string {
  if (num >= 1_000_000_000) {
    return (num / 1_000_000_000).toFixed(2) + 'B'
  }
  if (num >= 1_000_000) {
    return (num / 1_000_000).toFixed(2) + 'M'
  }
  if (num >= 1_000) {
    return (num / 1_000).toFixed(2) + 'K'
  }
  return num.toString()
}

// 工具函数：格式化百分比
export function formatPercent(num: number, decimals: number = 2): string {
  const sign = num >= 0 ? '+' : ''
  return `${sign}${num.toFixed(decimals)}%`
}

// 工具函数：获取排名颜色
export function getRankingColor(rank: number): {
  bg: string
  border: string
  text: string
  badge?: string
} {
  if (rank === 1) {
    return {
      bg: 'rgba(255,215,0,0.15)',
      border: 'rgba(255,215,0,0.3)',
      text: '#ffd700',
      badge: '🥇',
    }
  }
  if (rank === 2) {
    return {
      bg: 'rgba(192,192,192,0.15)',
      border: 'rgba(192,192,192,0.3)',
      text: '#c0c0c0',
      badge: '🥈',
    }
  }
  if (rank === 3) {
    return {
      bg: 'rgba(205,127,50,0.15)',
      border: 'rgba(205,127,50,0.3)',
      text: '#cd7f32',
      badge: '🥉',
    }
  }
  return {
    bg: '#0b0b0b',
    border: '#141414',
    text: '#8b8b8b',
  }
}







