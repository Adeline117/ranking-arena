// CSS keyframe animations for reset-password page
export const injectStyles = () => {
  if (typeof window === 'undefined') return
  if (document.getElementById('reset-password-styles')) return

  const style = document.createElement('style')
  style.id = 'reset-password-styles'
  style.textContent = `
    @keyframes resetGradient {
      0%, 100% { background-position: 0% 50%; }
      50% { background-position: 100% 50%; }
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

    @keyframes successPop {
      0% { transform: scale(0.8); opacity: 0; }
      50% { transform: scale(1.05); }
      100% { transform: scale(1); opacity: 1; }
    }

    @keyframes floatParticle {
      0%, 100% { transform: translateY(0px) rotate(0deg); opacity: 0.3; }
      50% { transform: translateY(-20px) rotate(180deg); opacity: 0.5; }
    }

    .reset-page-bg {
      position: fixed;
      inset: 0;
      background: var(--color-bg-primary);
      z-index: 0;
    }

    .reset-page-bg::before {
      content: '';
      position: absolute;
      top: -50%;
      left: -50%;
      width: 200%;
      height: 200%;
      background: radial-gradient(ellipse at center, var(--color-accent-primary-08) 0%, transparent 50%);
      animation: resetGradient 20s ease infinite;
    }

    .reset-card {
      animation: cardEnter 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards;
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
    }

    .reset-input {
      transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }

    .reset-input:focus {
      border-color: var(--color-brand) !important;
      animation: inputFocus 0.3s ease forwards;
      background: var(--color-accent-primary-08) !important;
    }

    .reset-button {
      transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }

    .reset-button:not(:disabled):hover {
      transform: translateY(-2px);
      animation: buttonPulse 2s ease infinite;
    }

    .reset-button:not(:disabled):active {
      transform: translateY(0) scale(0.98);
    }

    .error-shake {
      animation: shake 0.5s ease;
    }

    .success-message {
      animation: successPop 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
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

    .loader-spin {
      animation: spinLoader 1s linear infinite;
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

    .password-toggle {
      transition: all 0.2s ease;
    }

    .password-toggle:hover {
      color: var(--color-brand) !important;
    }
  `
  document.head.appendChild(style)
}
