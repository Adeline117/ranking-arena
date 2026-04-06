import { tokens } from '@/lib/design-tokens'

// 密码强度计算函数
export function getPasswordStrength(password: string): { level: 0 | 1 | 2 | 3 | 4; labelKey: string; color: string } {
  if (!password) return { level: 0, labelKey: '', color: '' }

  let score = 0
  if (password.length >= 6) score++
  if (password.length >= 8) score++
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++
  if (/\d/.test(password)) score++
  if (/[^a-zA-Z0-9]/.test(password)) score++

  if (score <= 1) return { level: 1, labelKey: 'loginPasswordWeak', color: tokens.colors.accent.error }
  if (score === 2) return { level: 2, labelKey: 'loginPasswordFair', color: tokens.colors.accent.warning }
  if (score === 3) return { level: 3, labelKey: 'loginPasswordGood', color: tokens.colors.accent.warning }
  return { level: 4, labelKey: 'loginPasswordStrong', color: tokens.colors.accent.success }
}

// 实时验证函数
export function validateEmail(email: string): { valid: boolean; messageKey: string } {
  if (!email) return { valid: true, messageKey: '' }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (!emailRegex.test(email)) {
    return { valid: false, messageKey: 'loginInvalidEmail' }
  }
  return { valid: true, messageKey: '' }
}

export function validatePassword(password: string): { valid: boolean; messageKey: string } {
  if (!password) return { valid: true, messageKey: '' }
  if (password.length < 6) {
    return { valid: false, messageKey: 'loginPasswordTooShort' }
  }
  return { valid: true, messageKey: '' }
}

export function validateHandle(handle: string): { valid: boolean; messageKey: string } {
  if (!handle) return { valid: true, messageKey: '' }
  if (handle.length < 1) {
    return { valid: false, messageKey: 'loginHandleTooShort' }
  }
  if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]+$/.test(handle)) {
    return { valid: false, messageKey: 'loginHandleInvalidChars' }
  }
  return { valid: true, messageKey: '' }
}

// CSS keyframe animations
export const injectStyles = () => {
  if (typeof window === 'undefined') return
  if (document.getElementById('login-page-styles')) return
  
  const style = document.createElement('style')
  style.id = 'login-page-styles'
  style.textContent = `
    @keyframes loginGradient {
      0%, 100% { background-position: 0% 50%; }
      50% { background-position: 100% 50%; }
    }
    
    @keyframes floatParticle {
      0%, 100% { transform: translateY(0px) rotate(0deg); opacity: 0.3; }
      50% { transform: translateY(-20px) rotate(180deg); opacity: 0.6; }
    }
    
    @keyframes cardEnter {
      from { 
        opacity: 0; 
        transform: translateY(30px) scale(0.95); 
        filter: blur(10px);
      }
      to { 
        opacity: 1; 
        transform: translateY(0) scale(1); 
        filter: blur(0);
      }
    }
    
    @keyframes inputFocus {
      0% { box-shadow: 0 0 0 0 var(--color-accent-primary-40); }
      100% { box-shadow: 0 0 0 4px var(--color-accent-primary-10); }
    }
    
    @keyframes buttonPulse {
      0%, 100% { box-shadow: 0 4px 20px var(--color-accent-primary-30); }
      50% { box-shadow: 0 4px 30px var(--color-accent-primary-60); }
    }
    
    @keyframes shake {
      0%, 100% { transform: translateX(0); }
      10%, 30%, 50%, 70%, 90% { transform: translateX(-4px); }
      20%, 40%, 60%, 80% { transform: translateX(4px); }
    }
    
    @keyframes spinLoader {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    
    @keyframes strengthBarFill {
      from { width: 0; }
    }
    
    @keyframes glowPulse {
      0%, 100% { opacity: 0.5; }
      50% { opacity: 1; }
    }
    
    .login-page-bg {
      position: fixed;
      inset: 0;
      background: var(--color-bg-primary);
      z-index: 0;
    }
    
    .login-page-bg::before {
      content: '';
      position: absolute;
      top: -50%;
      left: -50%;
      width: 200%;
      height: 200%;
      background: radial-gradient(ellipse at center, var(--color-accent-primary-08) 0%, transparent 50%);
      animation: loginGradient 20s ease infinite;
    }
    
    .login-card {
      animation: cardEnter 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards;
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
    }
    
    .login-input {
      transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }
    
    .login-input:focus {
      border-color: var(--color-brand) !important;
      animation: inputFocus 0.3s ease forwards;
      background: var(--color-accent-primary-08) !important;
    }
    
    .login-button {
      transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }
    
    .login-button:not(:disabled):hover {
      transform: translateY(-2px);
      animation: buttonPulse 2s ease infinite;
    }
    
    .login-button:not(:disabled):active {
      transform: translateY(0) scale(0.98);
    }
    
    .error-shake {
      animation: shake 0.5s ease;
    }
    
    .lang-btn {
      transition: all 0.2s ease;
    }
    
    .lang-btn:hover {
      transform: translateY(-1px);
    }
    
    .floating-particle {
      position: absolute;
      border-radius: 50%;
      background: linear-gradient(135deg, var(--color-accent-primary-30), var(--color-accent-primary-10));
      animation: floatParticle 6s ease-in-out infinite;
    }
    
    .password-toggle {
      transition: all 0.2s ease;
    }
    
    .password-toggle:hover {
      color: var(--color-brand) !important;
    }
    
    .strength-segment {
      transition: all 0.3s ease;
    }
    
    .link-hover {
      position: relative;
      transition: all 0.2s ease;
    }
    
    .link-hover::after {
      content: '';
      position: absolute;
      bottom: -2px;
      left: 0;
      width: 0;
      height: 1px;
      background: var(--color-brand);
      transition: width 0.3s ease;
    }
    
    .link-hover:hover::after {
      width: 100%;
    }
    
    .loader-spin {
      animation: spinLoader 1s linear infinite;
    }
  `
  document.head.appendChild(style)
}

// Loading spinner component
export const Spinner = () => (
  <svg className="loader-spin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
    <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
    <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
  </svg>
)
