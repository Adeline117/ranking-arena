/**
 * Theme Tokens - Light and Dark Mode Support
 * 支持亮色和暗色两种主题的设计令牌
 */

export type Theme = 'light' | 'dark'

export const lightTokens = {
  colors: {
    white: '#FFFFFF',
    black: '#000000',
    
    // Background hierarchy (light theme) — aligned with globals.css
    bg: {
      primary: '#FFFFFF',      // Pure white background
      secondary: '#F8F8FA',    // Light gray for cards
      tertiary: '#F0F0F4',     // Elevated surfaces
      hover: '#E8E8EC',        // Hover states
    },
    
    // Text hierarchy (WCAG AA contrast ratios on #FFFFFF) — aligned with globals.css
    text: {
      primary: '#1A1A1A',      // Almost black text (16.6:1)
      secondary: '#5A5A6A',    // Secondary text (7.1:1)
      tertiary: '#5F5F70',     // Muted text (5.5:1)
      disabled: '#9E9E9E',     // Disabled text (3.5:1)
    },
    
    // Border colors — aligned with globals.css
    border: {
      primary: '#E0E0E6',      // Subtle borders
      secondary: '#D0D0D8',    // Visible subtle borders
      focus: '#B0B0B0',        // Focus states
    },
    
    // Accent colors
    accent: {
      primary: '#1A1A1A',      // Primary actions
      success: '#00C853',      // Positive ROI/states
      warning: '#FF9800',      // Warnings
      error: '#F44336',        // Negative ROI/states
      brand: '#8b6fa8',        // Arena brand purple
      brandHover: '#9d84b5',   // Brand hover state
      brandMuted: 'rgba(139, 111, 168, 0.15)', // Brand muted background
      brandLight: '#c9b8db',   // Brand light for secondary text on brand bg
      translated: '#4A8A87',   // Translated text color (darker teal for light mode)
    },

    // Sentiment colors (bull/bear, positive/negative)
    sentiment: {
      bull: '#00C853',         // Bullish / positive
      bear: '#F44336',         // Bearish / negative
      neutral: '#9E9E9E',      // Neutral state
    },

    // Medal/rank colors
    medal: {
      gold: '#FFD700',
      goldEnd: '#FFA500',
      goldText: '#1a1200',
      silver: '#C0C0C0',
      silverEnd: '#A0A0A0',
      bronze: '#CD7F32',
      bronzeEnd: '#A0522D',
    },

    // Interactive state colors
    interactive: {
      inactive: '#9E9E9E',     // Inactive icons/text
      hover: '#BDBDBD',        // Hover on inactive elements
      favorite: '#F44336',     // Favorited/liked state
    },

    // Star/rating colors
    rating: {
      filled: '#f5c518',       // Active star
      empty: '#D0D0D8',        // Empty star background
    },

    // On-chain / web3 verified
    verified: {
      onchain: '#2fe57d',      // On-chain verified green
      web3: '#8B5CF6',         // Web3 verified purple
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
    
    // Text hierarchy (WCAG AA contrast ratios on #0B0A10)
    text: {
      primary: '#EDEDED',      // Primary text (14.5:1)
      secondary: '#9A9A9A',    // Secondary text (7.0:1)
      tertiary: '#898998',     // Muted text (5.7:1)
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
      brand: '#8b6fa8',        // Arena brand purple
      brandHover: '#9d84b5',   // Brand hover state
      brandMuted: 'rgba(139, 111, 168, 0.15)', // Brand muted background
      brandLight: '#c9b8db',   // Brand light for secondary text on brand bg
      translated: '#7CBBB8',   // Translated text color (soft teal for dark mode)
    },

    // Sentiment colors (bull/bear, positive/negative)
    sentiment: {
      bull: '#4DFF9A',         // Bullish / positive
      bear: '#FF4D4D',         // Bearish / negative
      neutral: '#898998',      // Neutral state
    },

    // Medal/rank colors
    medal: {
      gold: '#FFD700',
      goldEnd: '#FFA500',
      goldText: '#1a1200',
      silver: '#C0C0C0',
      silverEnd: '#A0A0A0',
      bronze: '#CD7F32',
      bronzeEnd: '#A0522D',
    },

    // Interactive state colors
    interactive: {
      inactive: '#9A9A9A',     // Inactive icons/text
      hover: '#D6D6D6',        // Hover on inactive elements
      favorite: '#ff7c7c',     // Favorited/liked state
    },

    // Star/rating colors
    rating: {
      filled: '#f5c518',       // Active star
      empty: '#3a3a2a',        // Empty star background
    },

    // On-chain / web3 verified
    verified: {
      onchain: '#2fe57d',      // On-chain verified green
      web3: '#8B5CF6',         // Web3 verified purple
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





