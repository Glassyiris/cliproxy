export default {
  en: {
    "use.page.what": "client keys",

    "use.steps.label": "Setup progress",
    "use.steps.tool": "Tool",
    "use.steps.settings": "Settings",
    "use.steps.test": "Test",
    "use.steps.back": "Back",
    "use.steps.continue": "Continue",
    "use.steps.done": "Done",
    "use.steps.needKey": "Create a client key first.",

    "use.choose.label": "Tool",
    "use.choose.cursor": "Needs a public HTTPS address",
    "use.choose.openaiSdk": "Python; Chat Completions and Responses",
    "use.choose.anthropicSdk": "Python",

    "use.settings.key": "Client key",
    "use.settings.model": "Model",
    "use.settings.checking": "Checking the models this key reaches…",
    "use.settings.noModels": "No models yet. Connect an account first.",
    "use.settings.modelsFailed": "Could not list the models. The next step tests the key.",
    "use.settings.localTitle": "Works only on this computer",
    "use.settings.localDescription":
      "Other machines need this server's network address; Cursor needs a public HTTPS address.",
    "use.settings.copy": "Copy",
    "use.settings.copied": "Copied.",
    "use.settings.copyFailed": "Could not copy the setup.",
    "use.settings.copyNote": "The copy includes the full key.",

    "use.test.address": "Address",
    "use.test.key": "Client key",
    "use.test.testing": "Testing the connection…",
    "use.test.ready": "Connection works",
    "use.test.readyDescription":
      "This key reaches {count, plural, one {# model} other {# models}}.",
    "use.test.noModels": "The key works, but no models are available yet",
    "use.test.noModelsDescription": "Connect an account first.",
    "use.test.failed": "Connection failed",
    "use.test.again": "Test again",

    "use.empty.title": "No client key yet",
    "use.empty.create": "Create a client key",
    "use.empty.created": "Client key created.",

    "use.note.claudeCode":
      "Run these in the shell you start Claude Code from. To keep them, add both to the env block of ~/.claude/settings.json.",
    "use.note.cursor":
      "The proxy needs a public HTTPS address, for example through a Cloudflare tunnel. Enter both values under Cursor Settings, Models.",
    "use.note.openaiSdk": "The JavaScript SDK takes the same baseURL and apiKey.",
    "use.note.anthropicSdk": "The address has no /v1; the SDK adds it.",
    "use.note.curl": "A 401 means the key is wrong.",
  },
  "zh-CN": {
    "use.page.what": "客户端密钥",

    "use.steps.label": "设置进度",
    "use.steps.tool": "工具",
    "use.steps.settings": "配置",
    "use.steps.test": "测试",
    "use.steps.back": "上一步",
    "use.steps.continue": "继续",
    "use.steps.done": "完成",
    "use.steps.needKey": "请先创建客户端密钥。",

    "use.choose.label": "工具",
    "use.choose.cursor": "需要公网 HTTPS 地址",
    "use.choose.openaiSdk": "Python，支持 Chat Completions 和 Responses",
    "use.choose.anthropicSdk": "Python",

    "use.settings.key": "客户端密钥",
    "use.settings.model": "模型",
    "use.settings.checking": "正在查询此密钥可用的模型…",
    "use.settings.noModels": "暂无可用模型，请先连接账号。",
    "use.settings.modelsFailed": "无法列出模型，下一步会测试此密钥。",
    "use.settings.localTitle": "仅限本机使用",
    "use.settings.localDescription": "其他设备需要此服务器的网络地址，Cursor 需要公网 HTTPS 地址。",
    "use.settings.copy": "复制",
    "use.settings.copied": "已复制",
    "use.settings.copyFailed": "无法复制配置",
    "use.settings.copyNote": "复制的内容包含完整密钥。",

    "use.test.address": "地址",
    "use.test.key": "客户端密钥",
    "use.test.testing": "正在测试连接…",
    "use.test.ready": "连接正常",
    "use.test.readyDescription": "此密钥可访问 {count, plural, other {# 个模型}}。",
    "use.test.noModels": "密钥可用，但暂无可用模型",
    "use.test.noModelsDescription": "请先连接账号。",
    "use.test.failed": "连接失败",
    "use.test.again": "重新测试",

    "use.empty.title": "还没有客户端密钥",
    "use.empty.create": "创建客户端密钥",
    "use.empty.created": "已创建客户端密钥",

    "use.note.claudeCode":
      "在启动 Claude Code 的 shell 中执行这些命令。要长期生效，把两个变量写入 ~/.claude/settings.json 的 env 块。",
    "use.note.cursor":
      "代理需要公网 HTTPS 地址，例如通过 Cloudflare Tunnel。在 Cursor Settings 的 Models 中填写这两个值。",
    "use.note.openaiSdk": "JavaScript SDK 使用相同的 baseURL 和 apiKey。",
    "use.note.anthropicSdk": "地址不带 /v1，SDK 会自动补上。",
    "use.note.curl": "返回 401 表示密钥有误。",
  },
  "zh-TW": {
    "use.page.what": "用戶端金鑰",

    "use.steps.label": "設定進度",
    "use.steps.tool": "工具",
    "use.steps.settings": "設定",
    "use.steps.test": "測試",
    "use.steps.back": "上一步",
    "use.steps.continue": "繼續",
    "use.steps.done": "完成",
    "use.steps.needKey": "請先建立用戶端金鑰。",

    "use.choose.label": "工具",
    "use.choose.cursor": "需要公開的 HTTPS 位址",
    "use.choose.openaiSdk": "Python，支援 Chat Completions 與 Responses",
    "use.choose.anthropicSdk": "Python",

    "use.settings.key": "用戶端金鑰",
    "use.settings.model": "模型",
    "use.settings.checking": "正在查詢此金鑰可用的模型…",
    "use.settings.noModels": "目前沒有可用模型，請先連接帳號。",
    "use.settings.modelsFailed": "無法列出模型，下一步會測試此金鑰。",
    "use.settings.localTitle": "僅限本機使用",
    "use.settings.localDescription":
      "其他裝置需要此伺服器的網路位址，Cursor 需要公開的 HTTPS 位址。",
    "use.settings.copy": "複製",
    "use.settings.copied": "已複製",
    "use.settings.copyFailed": "無法複製設定",
    "use.settings.copyNote": "複製的內容包含完整金鑰。",

    "use.test.address": "位址",
    "use.test.key": "用戶端金鑰",
    "use.test.testing": "正在測試連線…",
    "use.test.ready": "連線正常",
    "use.test.readyDescription": "此金鑰可存取 {count, plural, other {# 個模型}}。",
    "use.test.noModels": "金鑰可用，但目前沒有可用模型",
    "use.test.noModelsDescription": "請先連接帳號。",
    "use.test.failed": "連線失敗",
    "use.test.again": "重新測試",

    "use.empty.title": "還沒有用戶端金鑰",
    "use.empty.create": "建立用戶端金鑰",
    "use.empty.created": "已建立用戶端金鑰",

    "use.note.claudeCode":
      "在啟動 Claude Code 的 shell 中執行這些指令。要長期生效，請把兩個變數寫入 ~/.claude/settings.json 的 env 區塊。",
    "use.note.cursor":
      "代理需要公開的 HTTPS 位址，例如透過 Cloudflare Tunnel。在 Cursor Settings 的 Models 中填入這兩個值。",
    "use.note.openaiSdk": "JavaScript SDK 使用相同的 baseURL 與 apiKey。",
    "use.note.anthropicSdk": "位址不含 /v1，SDK 會自動補上。",
    "use.note.curl": "回傳 401 表示金鑰有誤。",
  },
};
