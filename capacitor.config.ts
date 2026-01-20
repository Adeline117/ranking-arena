import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor 配置文件
 * 使用远程模式：App 作为壳加载线上网站
 * 优点：网页和 App 共用代码，更新无需重新发布
 */
const config: CapacitorConfig = {
  // 应用标识符（用于应用商店）
  appId: 'com.arenafi.app',
  
  // 应用名称
  appName: 'Arena',
  
  // Web 资源目录（远程模式下仅用于初始化，实际加载远程 URL）
  webDir: 'public',
  
  // 远程服务器配置 - 加载线上网站
  server: {
    // 生产环境 URL
    url: process.env.CAPACITOR_SERVER_URL || 'https://www.arenafi.org',
    
    // 禁止明文 HTTP（强制 HTTPS）
    cleartext: false,
    
    // 允许导航到外部 URL（用于 OAuth 等）
    allowNavigation: [
      'www.arenafi.org',
      '*.supabase.co',
      'accounts.google.com',
      '*.stripe.com',
    ],
  },
  
  // Android 平台配置
  android: {
    // 允许混合内容（HTTPS 页面加载 HTTP 资源）- 关闭以增强安全性
    allowMixedContent: false,
    
    // 启用 Chrome DevTools 调试（仅开发环境）
    webContentsDebuggingEnabled: process.env.NODE_ENV === 'development',
    
    // 构建选项
    buildOptions: {
      // 签名配置（发布时使用）
      // keystorePath: 'arena-release.keystore',
      // keystoreAlias: 'arena',
    },
  },
  
  // iOS 平台配置
  ios: {
    // 内容模式
    contentInset: 'automatic',
    
    // 允许在 App 内打开链接
    allowsLinkPreview: true,
    
    // 滚动视图配置
    scrollEnabled: true,
  },
  
  // 插件配置
  plugins: {
    // 启动画面配置
    SplashScreen: {
      // 显示时长（毫秒）
      launchShowDuration: 2000,
      
      // 自动隐藏
      launchAutoHide: true,
      
      // 淡出动画时长
      launchFadeOutDuration: 500,
      
      // 背景色（与主题色一致）
      backgroundColor: '#0B0A10',
      
      // Android 启动画面图片
      androidSplashResourceName: 'splash',
      
      // iOS 启动画面
      iosSpinnerStyle: 'small',
      showSpinner: true,
      spinnerColor: '#8b6fa8',
    },
    
    // 状态栏配置
    StatusBar: {
      // 样式（light = 白色文字，dark = 黑色文字）
      style: 'light',
      
      // 背景色
      backgroundColor: '#0B0A10',
    },
  },
};

export default config;
