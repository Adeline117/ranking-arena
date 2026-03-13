import UIKit
import Capacitor
import WebKit

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?
    
    // 启动时间追踪（用于性能监控）
    private var launchStartTime: CFAbsoluteTime = 0

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // 记录启动开始时间
        launchStartTime = CFAbsoluteTimeGetCurrent()
        
        // 配置全局外观
        configureAppearance()
        
        // 配置 WebView 缓存策略
        configureWebViewCache()
        
        // 注册远程通知
        registerForPushNotifications(application)
        
        // 性能优化：预热 URLSession
        preloadURLSession()
        
        #if DEBUG
        print("Arena: App launched in \(String(format: "%.3f", CFAbsoluteTimeGetCurrent() - launchStartTime))s")
        #endif
        
        return true
    }
    
    // MARK: - 配置全局外观
    private func configureAppearance() {
        // 状态栏样式
        if #available(iOS 15.0, *) {
            let appearance = UINavigationBarAppearance()
            appearance.configureWithOpaqueBackground()
            appearance.backgroundColor = UIColor(red: 11/255, green: 10/255, blue: 16/255, alpha: 1.0)
            appearance.titleTextAttributes = [.foregroundColor: UIColor.white]
            UINavigationBar.appearance().standardAppearance = appearance
            UINavigationBar.appearance().scrollEdgeAppearance = appearance
        }
        
        // 设置窗口背景色（避免白屏闪烁）
        window?.backgroundColor = UIColor(red: 11/255, green: 10/255, blue: 16/255, alpha: 1.0)
    }
    
    // MARK: - WebView 缓存配置
    private func configureWebViewCache() {
        // 设置 URLCache 缓存策略
        URLCache.shared = URLCache(
            memoryCapacity: 50 * 1024 * 1024,  // 50 MB 内存缓存
            diskCapacity: 100 * 1024 * 1024,   // 100 MB 磁盘缓存
            diskPath: "arena_cache"
        )
    }
    
    // MARK: - 推送通知注册
    private func registerForPushNotifications(_ application: UIApplication) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, error in
            if granted {
                DispatchQueue.main.async {
                    application.registerForRemoteNotifications()
                }
            }
            #if DEBUG
            if let error = error {
                print("Arena: Push notification registration error: \(error)")
            }
            #endif
        }
    }
    
    // MARK: - 预加载 URLSession
    private func preloadURLSession() {
        // 预热网络连接
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 60
        config.urlCache = URLCache.shared
        config.requestCachePolicy = .returnCacheDataElseLoad
        
        // 启用 HTTP/2 多路复用
        config.httpMaximumConnectionsPerHost = 6
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // 应用即将进入非活动状态时暂停非必要任务
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // 进入后台时释放资源
        URLCache.shared.removeAllCachedResponses()
        
        // 请求后台执行时间以完成必要任务
        var backgroundTask: UIBackgroundTaskIdentifier = .invalid
        backgroundTask = application.beginBackgroundTask {
            application.endBackgroundTask(backgroundTask)
            backgroundTask = .invalid
        }
        
        // 模拟后台任务完成
        DispatchQueue.global().async {
            // 在这里执行需要在后台完成的任务
            Thread.sleep(forTimeInterval: 1)
            application.endBackgroundTask(backgroundTask)
            backgroundTask = .invalid
        }
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // 从后台返回时刷新数据
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // 清除应用图标角标
        application.applicationIconBadgeNumber = 0
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // 应用终止时保存必要数据
    }
    
    // MARK: - 远程通知处理
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02.2hhx", $0) }.joined()
        #if DEBUG
        print("Arena: Push token: \(token)")
        #endif
        // 可以将 token 发送到服务器
        NotificationCenter.default.post(
            name: .capacitorDidRegisterForRemoteNotifications,
            object: deviceToken
        )
    }
    
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        #if DEBUG
        print("Arena: Failed to register for remote notifications: \(error)")
        #endif
        NotificationCenter.default.post(
            name: .capacitorDidFailToRegisterForRemoteNotifications,
            object: error
        )
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // 处理 URL Scheme 和深度链接
        #if DEBUG
        print("Arena: Opening URL: \(url)")
        #endif
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // 处理通用链接 (Universal Links)
        #if DEBUG
        if let url = userActivity.webpageURL {
            print("Arena: Universal Link: \(url)")
        }
        #endif
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }
    
    // MARK: - 内存警告处理
    func applicationDidReceiveMemoryWarning(_ application: UIApplication) {
        // 清理缓存以释放内存
        URLCache.shared.removeAllCachedResponses()
        
        #if DEBUG
        print("Arena: Memory warning received, cache cleared")
        #endif
    }
}
