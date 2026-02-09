"use client";

import { useState, useEffect, useCallback } from "react";
import { useLanguage } from "@/app/components/Providers/LanguageProvider";
import { tokens } from '@/lib/design-tokens'

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/**
 * PWA 安装提示横幅
 * 在浏览器支持且用户尚未安装时显示安装引导
 */
export default function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [isInstalled, setIsInstalled] = useState(false);

  useEffect(() => {
    // 检查是否已经安装（standalone 模式）
    if (
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as any).standalone
    ) {
      setIsInstalled(true);
      return;
    }

    // 检查用户是否之前关闭过提示
    const dismissedAt = localStorage.getItem("pwa-install-dismissed");
    if (dismissedAt) {
      const daysSince =
        (Date.now() - parseInt(dismissedAt, 10)) / (1000 * 60 * 60 * 24);
      if (daysSince < 14) {
        setDismissed(true);
        return;
      }
    }

    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };

    window.addEventListener("beforeinstallprompt", handler);

    return () => {
      window.removeEventListener("beforeinstallprompt", handler);
    };
  }, []);

  const handleInstall = useCallback(async () => {
    if (!deferredPrompt) return;

    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;

    if (outcome === "accepted") {
      setIsInstalled(true);
    }
    setDeferredPrompt(null);
  }, [deferredPrompt]);

  const handleDismiss = useCallback(() => {
    setDismissed(true);
    localStorage.setItem("pwa-install-dismissed", Date.now().toString());
    setDeferredPrompt(null);
  }, []);

  const { t } = useLanguage();

  if (!deferredPrompt || dismissed || isInstalled) {
    return null;
  }

  return (
    <div
      role="banner"
      aria-label={t('pwaInstallBanner')}
      style={{
        position: "fixed",
        bottom: "env(safe-area-inset-bottom, 16px)",
        left: 16,
        right: 16,
        zIndex: 9999,
        background: "linear-gradient(135deg, var(--color-bg-secondary) 0%, var(--color-bg-primary) 100%)",
        border: "1px solid var(--color-accent-primary-30)",
        borderRadius: tokens.radius.lg,
        padding: "14px 16px",
        display: "flex",
        alignItems: "center",
        gap: 12,
        boxShadow: "0 4px 24px var(--color-overlay-dark)",
        maxWidth: 420,
        marginInline: "auto",
      }}
    >
      <img
        src="/icons/icon-192x192.png"
        alt="Arena app icon"
        width={40}
        height={40}
        style={{ borderRadius: tokens.radius.md, flexShrink: 0 }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            color: "var(--color-text-primary)",
            fontSize: 14,
            fontWeight: 600,
            lineHeight: 1.3,
          }}
        >
          {t('pwaInstallTitle')}
        </div>
        <div
          style={{
            color: "var(--color-text-tertiary)",
            fontSize: 12,
            lineHeight: 1.4,
            marginTop: 2,
          }}
        >
          {t('pwaInstallDesc')}
        </div>
      </div>
      <button
        onClick={handleInstall}
        aria-label={t('pwaInstallButton')}
        style={{
          background: "linear-gradient(135deg, var(--color-brand), var(--color-brand-hover))",
          color: "var(--foreground)",
          border: "none",
          borderRadius: tokens.radius.md,
          padding: "8px 16px",
          fontSize: 13,
          fontWeight: 600,
          cursor: "pointer",
          whiteSpace: "nowrap",
          flexShrink: 0,
        }}
      >
        {t('pwaInstallButton')}
      </button>
      <button
        onClick={handleDismiss}
        aria-label={t('close')}
        style={{
          background: "none",
          border: "none",
          color: "var(--color-score-low)",
          fontSize: 18,
          cursor: "pointer",
          padding: 4,
          lineHeight: 1.2,
          flexShrink: 0,
        }}
      >
        x
      </button>
    </div>
  );
}
