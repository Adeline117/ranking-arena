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
      primary: '#111111',      // Near-black text (18.9:1)
      secondary: '#3D3D4D',    // Secondary text (10.2:1)
      tertiary: '#4A4A5A',     // Muted text (8.0:1)
      disabled: '#767676',     // Disabled text (4.54:1 WCAG AA)
    },
    
    // Border colors — aligned with globals.css
    border: {
      primary: '#E0E0E6',      // Subtle borders
      secondary: '#D0D0D8',    // Visible subtle borders
      focus: '#B0B0B0',        // Focus states
    },
    
    // Accent colors
    accent: {
      primary: '#111111',      // Primary actions
      success: '#15803D',      // Positive ROI/states (WCAG AA 5.1:1 on white)
      warning: '#b45309',      // Warnings (WCAG AA 5.3:1 on white)
      error: '#DC2626',        // Negative ROI/states (WCAG AA 4.6:1 on white)
      brand: '#8b6fa8',        // Arena brand purple
      brandHover: '#9d84b5',   // Brand hover state
      brandMuted: 'rgba(139, 111, 168, 0.15)', // Brand muted background
      brandLight: '#c9b8db',   // Brand light for secondary text on brand bg
      translated: '#357574',   // Translated text color (WCAG AA 5.4:1 on white)
    },

    // Sentiment colors (bull/bear, positive/negative)
    sentiment: {
      bull: '#15803D',         // Bullish / positive (WCAG AA on white)
      bear: '#DC2626',         // Bearish / negative (WCAG AA on white)
      neutral: '#767676',      // Neutral state (4.54:1 WCAG AA on white)
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
      inactive: '#767676',     // Inactive icons/text (4.54:1 WCAG AA on white)
      hover: '#BDBDBD',        // Hover on inactive elements
      favorite: '#F44336',     // Favorited/liked state
    },

    // Star/rating colors
    rating: {
      filled: '#946800',       // Active star (WCAG AA 5.0:1 on white)
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
      primary: '#F0F0F0',      // Primary text (15.3:1)
      secondary: '#B8B8C3',    // Secondary text (9.5:1)
      tertiary: '#9E9EB0',     // Muted text (7.2:1)
      disabled: '#6B6B6B',     // Disabled text (4.5:1 WCAG AA on #0B0A10)
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
      brand: '#9A85B5',        // Arena brand purple (WCAG AA 5.6:1 on card bg)
      brandHover: '#B09DC8',   // Brand hover state (brighter)
      brandMuted: 'rgba(154, 133, 181, 0.15)', // Brand muted background
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





