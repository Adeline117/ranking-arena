# Arena App 构建指南

本文档说明如何将 Arena 网站打包成 iOS 和 Android 原生应用。

## 技术方案

使用 **Capacitor 远程模式**：
- App 作为"壳"加载线上网站 `https://www.arenafi.org`
- 网页和 App 共用同一套代码
- 更新网站内容无需重新发布 App

## 前置要求

### Android 开发
- [Android Studio](https://developer.android.com/studio)（最新版）
- JDK 17+
- Android SDK（通过 Android Studio 安装）

### iOS 开发
- macOS 电脑
- [Xcode](https://apps.apple.com/app/xcode/id497799835)（最新版）
- Apple Developer 账号（$99/年）

## 快速开始

### 1. 同步项目

```bash
# 同步所有平台
npm run cap:sync

# 仅同步 Android
npx cap sync android

# 仅同步 iOS
npx cap sync ios
```

### 2. 打开原生项目

```bash
# 打开 Android Studio
npm run cap:android

# 打开 Xcode
npm run cap:ios
```

## Android 构建与发布

### 开发调试

1. 运行 `npm run cap:android` 打开 Android Studio
2. 连接 Android 设备或启动模拟器
3. 点击 "Run" 按钮

### 生成签名密钥（首次）

```bash
keytool -genkey -v -keystore arena-release.keystore -alias arena -keyalg RSA -keysize 2048 -validity 10000
```

**重要**：妥善保管 keystore 文件和密码，丢失后无法更新 App！

### 构建发布版 APK/AAB

1. 在 Android Studio 中：Build → Generate Signed Bundle/APK
2. 选择 "Android App Bundle"（推荐）或 "APK"
3. 选择 keystore 并输入密码
4. 选择 "release" 构建类型
5. 输出文件位于 `android/app/build/outputs/`

### 上传到 Google Play

1. 访问 [Google Play Console](https://play.google.com/console)
2. 创建应用 → 填写基本信息
3. 上传 AAB 文件
4. 填写商店列表、截图、隐私政策
5. 提交审核

## iOS 构建与发布

### 开发调试

1. 运行 `npm run cap:ios` 打开 Xcode
2. 选择目标设备（模拟器或真机）
3. 点击 "Play" 按钮运行

### 配置签名

1. 在 Xcode 中选择项目 → Signing & Capabilities
2. 选择你的 Team（Apple Developer 账号）
3. 设置 Bundle Identifier: `com.arenafi.app`

### 构建发布版

1. 选择 "Any iOS Device" 作为目标
2. Product → Archive
3. 等待 Archive 完成
4. Window → Organizer → 选择 Archive
5. 点击 "Distribute App"
6. 选择 "App Store Connect"

### 上传到 App Store

1. 访问 [App Store Connect](https://appstoreconnect.apple.com)
2. 创建新 App → 填写基本信息
3. 选择刚上传的构建版本
4. 填写 App 信息、截图、描述
5. 提交审核

## 图标配置

### 生成图标

使用 [Capacitor Assets](https://github.com/ionic-team/capacitor-assets) 自动生成各尺寸图标：

```bash
# 安装工具
npm install -g @capacitor/assets

# 生成图标（需要 resources/icon.png 1024x1024）
npx capacitor-assets generate --iconBackgroundColor '#0B0A10'
```

或手动准备以下尺寸（放在 `public/icons/`）：

| 尺寸 | 用途 |
|------|------|
| 72x72 | Android mdpi |
| 96x96 | Android hdpi |
| 128x128 | Web |
| 144x144 | Android xhdpi |
| 152x152 | iOS iPad |
| 192x192 | Android xxxhdpi, Web |
| 384x384 | Android |
| 512x512 | Google Play |
| 1024x1024 | App Store |

### 启动画面

在 `resources/splash.png` 放置 2732x2732 的启动画面图片。

## 配置说明

### capacitor.config.ts

```typescript
const config: CapacitorConfig = {
  appId: 'com.arenafi.app',      // 应用 ID
  appName: 'Arena',              // 应用名称
  webDir: 'public',              // Web 资源目录
  
  server: {
    url: 'https://www.arenafi.org',  // 远程 URL
    cleartext: false,                 // 强制 HTTPS
  },
};
```

### 修改远程 URL

如需更改加载的 URL（如测试环境），修改 `capacitor.config.ts` 中的 `server.url`：

```typescript
server: {
  url: process.env.CAPACITOR_SERVER_URL || 'https://www.arenafi.org',
}
```

然后重新同步：

```bash
CAPACITOR_SERVER_URL=https://staging.arenafi.org npx cap sync
```

## 常见问题

### Q: App 打开是白屏？
A: 检查网络连接和 URL 配置。远程模式需要网络才能加载。

### Q: 如何调试 Web 内容？
A: 
- Android: Chrome DevTools → `chrome://inspect`
- iOS: Safari → 开发 → 选择设备

### Q: 如何更新 App 内容？
A: 直接更新网站代码并部署，App 会自动加载最新内容。

### Q: 需要重新发布 App 吗？
A: 只有以下情况需要：
- 修改原生配置（图标、启动画面、权限等）
- 升级 Capacitor 版本
- 添加新的原生插件

## 应用商店资料准备

### Google Play 所需材料

- [ ] 应用图标 512x512 PNG
- [ ] 功能图 1024x500 PNG
- [ ] 手机截图 (最少 2 张)
- [ ] 平板截图（可选）
- [ ] 应用简短描述 (80 字以内)
- [ ] 应用详细描述 (4000 字以内)
- [ ] 隐私政策 URL
- [ ] 开发者联系邮箱

### App Store 所需材料

- [ ] 应用图标 1024x1024 PNG（无透明）
- [ ] iPhone 6.7" 截图 (1290x2796)
- [ ] iPhone 6.5" 截图 (1284x2778)
- [ ] iPad 12.9" 截图（可选）
- [ ] 应用副标题 (30 字以内)
- [ ] 应用描述 (4000 字以内)
- [ ] 关键词 (100 字以内)
- [ ] 隐私政策 URL
- [ ] 技术支持 URL

## 相关文档

- [Capacitor 官方文档](https://capacitorjs.com/docs)
- [Google Play Console 帮助](https://support.google.com/googleplay/android-developer)
- [App Store Connect 帮助](https://developer.apple.com/app-store-connect/)
