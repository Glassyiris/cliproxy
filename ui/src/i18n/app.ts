export default {
  en: {
    "app.brand.name": "cliproxy-rs",
    "app.document.pageTitle": "{title} · cliproxy-rs",
    "app.document.signInTitle": "Sign in · cliproxy-rs",

    "app.signIn.managementKey": "Management key",
    "app.signIn.help":
      "Use the plain text you set as {setting} (on first start the server replaces it in config.yaml with a hash), or the MANAGEMENT_PASSWORD the server was started with. It stays in this tab’s memory only; reloading signs you out.",
    "app.signIn.connect": "Connect",
    "app.signIn.connecting": "Connecting…",
    "app.signIn.apiOff":
      "The management API is off on this server. Set management.secret-key in the server's config.yaml (or start it with MANAGEMENT_PASSWORD), then restart it.",
    "app.signIn.remoteDisabled":
      "This server accepts the dashboard only from its own machine. Open it there, or set management.allow-remote: true in config.yaml with a strong key.",
    "app.signIn.banned": "{message}. Too many wrong keys came from this address.",
    "app.signIn.wrongKey":
      "That key is not right. Use the plain text you set as management.secret-key: on first start the server replaces it in config.yaml with a hash, so the file no longer shows it.",
    "app.connection.unreachable":
      "The server did not answer. Check that it is running and that this address reaches it.",
    "app.connection.timeout": "The server did not answer within 30 seconds. Try again.",
    "app.signIn.rejected": "The management key was rejected. Sign in again.",

    "app.nav.label": "Pages",
    "app.nav.session": "Session",
    "app.nav.system": "System",
    "app.nav.github": "GitHub",
    "app.nav.signOut": "Sign out",
    "app.connection.connected": "Connected to {host}",
    "app.connection.version": "Server {version}",
    "app.connection.lost": "Connection lost",

    "app.theme.label": "Theme",
    "app.theme.system": "Match system",
    "app.theme.light": "Light",
    "app.theme.dark": "Dark",
    "app.locale.label": "Language",

    "app.read.loading": "Loading {what}",
    "app.read.failed": "Could not load {what}",
    "app.read.unavailable": "Not available on this server",
    "app.read.unimplemented":
      "{method} {path} answered {status}. It is part of the v8 API, but this server does not implement it yet.",
    "app.read.retry": "Retry",
    "app.page.failedTitle": "This page could not be shown",
    "app.page.failedDescription": "Try again. If it keeps failing, reload the dashboard.",
    "app.page.chunkFailedDescription":
      "The code for this page could not be loaded. Reload the dashboard to fetch it again. Reloading signs you out, because the key is kept only in this tab’s memory.",
    "app.page.reload": "Reload",
    "app.notice.dismiss": "Dismiss",
  },
  "zh-CN": {
    "app.brand.name": "cliproxy-rs",
    "app.document.pageTitle": "{title} · cliproxy-rs",
    "app.document.signInTitle": "登录 · cliproxy-rs",

    "app.signIn.managementKey": "管理密钥",
    "app.signIn.help":
      "输入为 {setting} 设置的明文（服务器首次启动时会把 config.yaml 中的值换成哈希），或启动服务器时设置的 MANAGEMENT_PASSWORD。密钥只保存在此标签页的内存中，刷新页面后需要重新登录。",
    "app.signIn.connect": "连接",
    "app.signIn.connecting": "正在连接…",
    "app.signIn.apiOff":
      "此服务器未开启管理 API。请在服务器的 config.yaml 中设置 management.secret-key（或以 MANAGEMENT_PASSWORD 启动），然后重启服务器。",
    "app.signIn.remoteDisabled":
      "此服务器只接受本机打开的面板。请在服务器所在的机器上打开，或在 config.yaml 中设置 management.allow-remote: true 并使用强密钥。",
    "app.signIn.banned": "{message}。此地址输错密钥的次数过多。",
    "app.signIn.wrongKey":
      "密钥不正确。请填写设置 management.secret-key 时使用的明文：服务器首次启动时会把 config.yaml 中的值替换为哈希，文件里已看不到原文。",
    "app.connection.unreachable": "服务器没有响应。请确认服务器正在运行，并且此地址可以访问它。",
    "app.connection.timeout": "服务器在 30 秒内没有响应。请重试。",
    "app.signIn.rejected": "管理密钥已被拒绝。请重新登录。",

    "app.nav.label": "页面",
    "app.nav.session": "会话",
    "app.nav.system": "系统",
    "app.nav.github": "GitHub",
    "app.nav.signOut": "退出登录",
    "app.connection.connected": "已连接 {host}",
    "app.connection.version": "服务器 {version}",
    "app.connection.lost": "连接已断开",

    "app.theme.label": "主题",
    "app.theme.system": "跟随系统",
    "app.theme.light": "浅色",
    "app.theme.dark": "深色",
    "app.locale.label": "语言",

    "app.read.loading": "正在加载{what}",
    "app.read.failed": "无法加载{what}",
    "app.read.unavailable": "此服务器不支持",
    "app.read.unimplemented": "{method} {path} 返回 {status}。它属于 v8 API，但此服务器尚未实现。",
    "app.read.retry": "重试",
    "app.page.failedTitle": "无法显示此页面",
    "app.page.failedDescription": "请重试。如果仍然失败，请刷新面板。",
    "app.page.chunkFailedDescription":
      "无法加载此页面的代码。请刷新面板重新获取。密钥只保存在此标签页的内存中，因此刷新后需要重新登录。",
    "app.page.reload": "刷新",
    "app.notice.dismiss": "关闭",
  },
  "zh-TW": {
    "app.brand.name": "cliproxy-rs",
    "app.document.pageTitle": "{title} · cliproxy-rs",
    "app.document.signInTitle": "登入 · cliproxy-rs",

    "app.signIn.managementKey": "管理金鑰",
    "app.signIn.help":
      "輸入為 {setting} 設定的明文（伺服器首次啟動時會把 config.yaml 中的值換成雜湊），或啟動伺服器時設定的 MANAGEMENT_PASSWORD。金鑰只保存在此分頁的記憶體中，重新載入頁面後需要重新登入。",
    "app.signIn.connect": "連線",
    "app.signIn.connecting": "正在連線…",
    "app.signIn.apiOff":
      "此伺服器未開啟管理 API。請在伺服器的 config.yaml 中設定 management.secret-key（或以 MANAGEMENT_PASSWORD 啟動），然後重新啟動伺服器。",
    "app.signIn.remoteDisabled":
      "此伺服器只接受本機開啟的面板。請在伺服器所在的機器上開啟，或在 config.yaml 中設定 management.allow-remote: true 並使用強金鑰。",
    "app.signIn.banned": "{message}。此位址輸錯金鑰的次數過多。",
    "app.signIn.wrongKey":
      "金鑰不正確。請填寫設定 management.secret-key 時使用的明文：伺服器首次啟動時會把 config.yaml 中的值換成雜湊，檔案裡已看不到原文。",
    "app.connection.unreachable": "伺服器沒有回應。請確認伺服器正在執行，且此位址可以連到它。",
    "app.connection.timeout": "伺服器在 30 秒內沒有回應。請重試。",
    "app.signIn.rejected": "管理金鑰已被拒絕。請重新登入。",

    "app.nav.label": "頁面",
    "app.nav.session": "工作階段",
    "app.nav.system": "系統",
    "app.nav.github": "GitHub",
    "app.nav.signOut": "登出",
    "app.connection.connected": "已連線到 {host}",
    "app.connection.version": "伺服器 {version}",
    "app.connection.lost": "連線已中斷",

    "app.theme.label": "主題",
    "app.theme.system": "跟隨系統",
    "app.theme.light": "淺色",
    "app.theme.dark": "深色",
    "app.locale.label": "語言",

    "app.read.loading": "正在載入{what}",
    "app.read.failed": "無法載入{what}",
    "app.read.unavailable": "此伺服器不支援",
    "app.read.unimplemented": "{method} {path} 回傳 {status}。它屬於 v8 API，但此伺服器尚未實作。",
    "app.read.retry": "重試",
    "app.page.failedTitle": "無法顯示此頁面",
    "app.page.failedDescription": "請重試。如果仍然失敗，請重新載入面板。",
    "app.page.chunkFailedDescription":
      "無法載入此頁面的程式碼。請重新載入面板以再次取得。金鑰只保存在此分頁的記憶體中，因此重新載入後需要重新登入。",
    "app.page.reload": "重新載入",
    "app.notice.dismiss": "關閉",
  },
};
