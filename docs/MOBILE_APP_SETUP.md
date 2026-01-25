# Mobile App Setup Guide

This guide covers the configuration needed to build and deploy the Arena iOS and Android apps.

## Prerequisites

- Apple Developer Account ($99/year) for iOS
- Google Play Developer Account ($25 one-time) for Android
- Firebase project for push notifications
- Xcode 15+ (macOS only) for iOS builds
- Android Studio for Android builds

---

## 1. Apple Developer Setup (iOS)

### Get Your Team ID

1. Go to [Apple Developer Account](https://developer.apple.com/account)
2. Navigate to **Membership** in the sidebar
3. Copy your **Team ID** (10-character alphanumeric)

### Update Universal Links

Edit `public/.well-known/apple-app-site-association`:

```json
{
  "applinks": {
    "details": [
      {
        "appID": "YOUR_TEAM_ID.com.arenafi.app",
        ...
      }
    ]
  },
  "webcredentials": {
    "apps": ["YOUR_TEAM_ID.com.arenafi.app"]
  }
}
```

Replace `YOUR_TEAM_ID` with your actual Team ID (e.g., `ABC123XYZ0`).

### Create App ID & Capabilities

1. Go to **Certificates, Identifiers & Profiles**
2. Create new **App ID** with Bundle ID: `com.arenafi.app`
3. Enable capabilities:
   - Associated Domains
   - Push Notifications
   - Sign in with Apple (if needed)

### Create Push Notification Key

1. Go to **Keys** in Apple Developer
2. Create new key with **Apple Push Notifications service (APNs)**
3. Download the `.p8` file (save securely, only downloadable once)
4. Note the **Key ID** and your **Team ID**

---

## 2. Firebase Setup (Push Notifications)

### Create Firebase Project

1. Go to [Firebase Console](https://console.firebase.google.com)
2. Create new project or use existing
3. Add iOS and Android apps

### Android Configuration

1. Add Android app with package name: `com.arenafi.app`
2. Download `google-services.json`
3. Place it in: `android/app/google-services.json`

### iOS Configuration

1. Add iOS app with Bundle ID: `com.arenafi.app`
2. Download `GoogleService-Info.plist`
3. Place it in: `ios/App/App/GoogleService-Info.plist`

### Upload APNs Key to Firebase

1. In Firebase Console, go to **Project Settings** > **Cloud Messaging**
2. Under **Apple app configuration**, upload your APNs key (.p8 file)
3. Enter the Key ID and Team ID

---

## 3. Android App Links Setup

### Get SHA256 Fingerprint

For debug builds:
```bash
cd android
./gradlew signingReport
```

For release builds, use your keystore:
```bash
keytool -list -v -keystore your-release-key.keystore -alias your-alias
```

Copy the SHA256 fingerprint (looks like: `AA:BB:CC:...`).

### Update assetlinks.json

Edit `public/.well-known/assetlinks.json`:

```json
[
  {
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "com.arenafi.app",
      "sha256_cert_fingerprints": [
        "YOUR_SHA256_FINGERPRINT"
      ]
    }
  }
]
```

Replace `YOUR_SHA256_FINGERPRINT` with your actual fingerprint.

**Note:** For development, add both debug and release fingerprints:
```json
"sha256_cert_fingerprints": [
  "DEBUG_SHA256_FINGERPRINT",
  "RELEASE_SHA256_FINGERPRINT"
]
```

---

## 4. Environment Variables

Create `.env.local` with these variables:

```bash
# Firebase (Server-side push notifications)
FCM_SERVER_KEY=your_fcm_server_key
FCM_PROJECT_ID=your_firebase_project_id

# APNs (iOS push - if using direct APNs instead of FCM)
APNS_KEY_ID=your_apns_key_id
APNS_TEAM_ID=your_apple_team_id
APNS_KEY_PATH=./secrets/apns-key.p8
```

---

## 5. Build Commands

### Development

```bash
# Sync web assets to native projects
npm run cap:sync

# Open in Xcode (iOS)
npm run cap:open:ios

# Open in Android Studio
npm run cap:open:android

# Run on simulator/emulator
npm run cap:run:ios
npm run cap:run:android
```

### Production Build

```bash
# Build web assets first
npm run build

# Sync to native projects
npm run cap:sync

# Then build in Xcode/Android Studio for release
```

---

## 6. App Store Submission Checklist

### iOS (App Store Connect)

- [ ] App icon: 1024x1024 PNG (no alpha)
- [ ] Screenshots: iPhone 6.5", iPhone 5.5", iPad 12.9"
- [ ] App description (4000 chars max)
- [ ] Keywords (100 chars max)
- [ ] Privacy Policy URL
- [ ] Support URL
- [ ] Age rating questionnaire
- [ ] Export compliance (uses encryption?)

### Android (Google Play Console)

- [ ] App icon: 512x512 PNG
- [ ] Feature graphic: 1024x500 PNG
- [ ] Screenshots: Phone, 7" tablet, 10" tablet
- [ ] Short description (80 chars)
- [ ] Full description (4000 chars)
- [ ] Privacy Policy URL
- [ ] Content rating questionnaire
- [ ] Target audience declaration

---

## Troubleshooting

### Universal Links not working (iOS)

1. Verify AASA file is accessible: `curl https://www.arenafi.org/.well-known/apple-app-site-association`
2. Check Content-Type header is `application/json`
3. Validate with [Apple's validator](https://search.developer.apple.com/appsearch-validation-tool/)
4. Delete and reinstall app to refresh link associations

### App Links not working (Android)

1. Verify assetlinks.json is accessible: `curl https://www.arenafi.org/.well-known/assetlinks.json`
2. Use Android Debug Bridge: `adb shell am start -a android.intent.action.VIEW -d "https://www.arenafi.org/trader/test"`
3. Check Digital Asset Links: [Google's tester](https://developers.google.com/digital-asset-links/tools/generator)

### Push notifications not received

1. Check Firebase Console for delivery reports
2. Verify device token is registered in `push_subscriptions` table
3. Check notification permissions on device
4. For iOS: ensure APNs key is uploaded to Firebase
