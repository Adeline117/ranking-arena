/**
 * Theme Tokens - Light and Dark Mode Support
 * 支持亮色和暗色两种主题的设计令牌
 */

export type Theme = 'light' | 'dark'

export const lightTokens = {
  colors: {
    white: '#FFFFFF',
    black: '#000000',
    
    // Background hierarchy (light theme)
    bg: {
      primary: '#FFFFFF',      // Pure white background
      secondary: '#F5F5F5',    // Light gray for cards
      tertiary: '#EEEEEE',     // Elevated surfaces
      hover: '#E5E5E5',        // Hover states
    },
    
    // Text hierarchy
    text: {
      primary: '#1A1A1A',      // Almost black text
      secondary: '#666666',    // Secondary text
      tertiary: '#999999',     // Muted text
      disabled: '#CCCCCC',     // Disabled text
    },
    
    // Border colors
    border: {
      primary: '#E0E0E0',      // Subtle borders
      secondary: '#F0F0F0',    // Very subtle borders
      focus: '#B0B0B0',        // Focus states
    },
    
    // Accent colors
    accent: {
      primary: '#1A1A1A',      // Primary actions
      success: '#00C853',      // Positive ROI/states
      warning: '#FF9800',      // Warnings
      error: '#F44336',        // Negative ROI/states
    },
    
    overlay: {
      light: 'rgba(0, 0, 0, 0.1)',
      medium: 'rgba(0, 0, 0, 0.3)',
      dark: 'rgba(0, 0, 0, 0.6)',
    },
  },
}

export const darkTokens = {
  colors: {
    white: '#FFFFFF',
    black: '#000000',
    
    // Background hierarchy (dark theme - near-black deep purple)
    bg: {
      primary: '#0B0A10',      // Near-black deep purple
      secondary: '#14131A',    // Panel/card background
      tertiary: '#1C1B23',     // Elevated/hover states
      hover: '#23222B',        // Subtle hover
    },
    
    // Text hierarchy
    text: {
      primary: '#EDEDED',      // Primary text
      secondary: '#9A9A9A',    // Secondary text
      tertiary: '#6F6F6F',     // Muted text
      disabled: '#404040',     // Disabled text
    },
    
    // Border colors
    border: {
      primary: '#23222B',      // Subtle borders
      secondary: '#1C1B23',    // Very subtle borders
      focus: '#2A2933',        // Focus states
    },
    
    // Accent colors
    accent: {
      primary: '#EDEDED',      // Primary actions
      success: '#4DFF9A',      // Positive ROI/states
      warning: '#FFB800',      // Warnings
      error: '#FF4D4D',        // Negative ROI/states
    },
    
    overlay: {
      light: 'rgba(0, 0, 0, 0.4)',
      medium: 'rgba(0, 0, 0, 0.6)',
      dark: 'rgba(0, 0, 0, 0.8)',
    },
  },
}

// 导出当前主题的令牌（根据data-theme属性动态获取）
export function getThemeTokens(theme: Theme = 'dark') {
  return theme === 'light' ? lightTokens : darkTokens
}

