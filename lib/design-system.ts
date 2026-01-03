/**
 * Design System - Ranking Arena
 * 统一的设计系统配置
 */

export const colors = {
  // 背景色
  bg: {
    primary: '#060606',
    secondary: '#0b0b0b',
    tertiary: '#111111',
    card: 'rgba(255,255,255,0.03)',
    cardHover: 'rgba(255,255,255,0.05)',
    input: '#0b0b0b',
    modal: 'rgba(0,0,0,0.75)',
  },
  
  // 文字色
  text: {
    primary: '#f2f2f2',
    secondary: '#eaeaea',
    tertiary: '#bdbdbd',
    muted: '#9a9a9a',
    disabled: '#777777',
  },
  
  // 边框色
  border: {
    primary: '#1f1f1f',
    secondary: '#141414',
    tertiary: 'rgba(255,255,255,0.08)',
    hover: 'rgba(255,255,255,0.12)',
  },
  
  // 主题色
  theme: {
    purple: '#8b6fa8',
    purpleLight: '#a085b8',
    purpleDark: '#6d5580',
    purpleBg: 'rgba(139,111,168,0.15)',
  },
  
  // 状态色
  status: {
    success: '#2fe57d',
    successBg: 'rgba(47,229,125,0.15)',
    error: '#ff4d4d',
    errorBg: 'rgba(255,77,77,0.15)',
    warning: '#ffb84d',
    warningBg: 'rgba(255,184,77,0.15)',
    info: '#4d9fff',
    infoBg: 'rgba(77,159,255,0.15)',
  },
  
  // 排行榜特殊颜色
  ranking: {
    gold: '#ffd700',
    silver: '#c0c0c0',
    bronze: '#cd7f32',
    goldBg: 'rgba(255,215,0,0.15)',
    silverBg: 'rgba(192,192,192,0.15)',
    bronzeBg: 'rgba(205,127,50,0.15)',
  },
  
  // 图表色
  chart: {
    positive: '#2fe57d',
    negative: '#ff4d4d',
    neutral: '#8b6fa8',
  },
}

export const spacing = {
  xs: '4px',
  sm: '8px',
  md: '12px',
  lg: '16px',
  xl: '20px',
  '2xl': '24px',
  '3xl': '32px',
  '4xl': '40px',
}

export const borderRadius = {
  sm: '8px',
  md: '12px',
  lg: '16px',
  xl: '18px',
  '2xl': '20px',
  full: '9999px',
}

export const shadows = {
  sm: '0 1px 2px rgba(0,0,0,0.3)',
  md: '0 4px 6px rgba(0,0,0,0.4)',
  lg: '0 10px 15px rgba(0,0,0,0.5)',
  xl: '0 20px 25px rgba(0,0,0,0.6)',
  glow: '0 0 20px rgba(139,111,168,0.3)',
  glowStrong: '0 0 30px rgba(139,111,168,0.5)',
}

export const transitions = {
  fast: '150ms ease',
  normal: '200ms ease',
  slow: '300ms ease',
  bounce: '300ms cubic-bezier(0.68, -0.55, 0.265, 1.55)',
}

export const typography = {
  fontFamily: {
    sans: 'system-ui, -apple-system, sans-serif',
    mono: 'ui-monospace, monospace',
  },
  fontSize: {
    xs: '11px',
    sm: '12px',
    md: '13px',
    base: '14px',
    lg: '16px',
    xl: '18px',
    '2xl': '20px',
    '3xl': '24px',
    '4xl': '32px',
  },
  fontWeight: {
    normal: 400,
    medium: 500,
    semibold: 600,
    bold: 700,
    extrabold: 800,
    black: 900,
  },
  lineHeight: {
    tight: 1.2,
    normal: 1.5,
    relaxed: 1.7,
  },
}

export const zIndex = {
  base: 1,
  dropdown: 100,
  sticky: 200,
  overlay: 300,
  modal: 400,
  popover: 500,
  tooltip: 600,
}

