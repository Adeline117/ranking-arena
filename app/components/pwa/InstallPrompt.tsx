"use client";

import { useState, useEffect, useCallback } from "react";

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

  if (!deferredPrompt || dismissed || isInstalled) {
    return null;
  }

  return (
    <div
      role="banner"
      aria-label="安装应用提示"
      style={{
        position: "fixed",
        bottom: "env(safe-area-inset-bottom, 16px)",
        left: 16,
        right: 16,
        zIndex: 9999,
        background: "linear-gradient(135deg, #1a1825 0%, #0B0A10 100%)",
        border: "1px solid rgba(139, 111, 168, 0.3)",
        borderRadius: 12,
        padding: "14px 16px",
        display: "flex",
        alignItems: "center",
        gap: 12,
        boxShadow: "0 4px 24px rgba(0, 0, 0, 0.5)",
        maxWidth: 420,
        marginInline: "auto",
      }}
    >
      <img
        src="/icons/icon-192x192.png"
        alt=""
        width={40}
        height={40}
        style={{ borderRadius: 8, flexShrink: 0 }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            color: "#EDEDED",
            fontSize: 14,
            fontWeight: 600,
            lineHeight: 1.3,
          }}
        >
          安装竞技场
        </div>
        <div
          style={{
            color: "#9CA3AF",
            fontSize: 12,
            lineHeight: 1.4,
            marginTop: 2,
          }}
        >
          添加到主屏幕，获得更快的访问体验
        </div>
      </div>
      <button
        onClick={handleInstall}
        aria-label="安装应用"
        style={{
          background: "linear-gradient(135deg, #8b6fa8, #a88bc4)",
          color: "#fff",
          border: "none",
          borderRadius: 8,
          padding: "8px 16px",
          fontSize: 13,
          fontWeight: 600,
          cursor: "pointer",
          whiteSpace: "nowrap",
          flexShrink: 0,
        }}
      >
        安装
      </button>
      <button
        onClick={handleDismiss}
        aria-label="关闭安装提示"
        style={{
          background: "none",
          border: "none",
          color: "#6B7280",
          fontSize: 18,
          cursor: "pointer",
          padding: 4,
          lineHeight: 1,
          flexShrink: 0,
        }}
      >
        x
      </button>
    </div>
  );
}
