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
    "use.choose.claudeCode": "Two environment variables for the claude command",
    "use.choose.codexCli": "A provider in ~/.codex/config.toml",
    "use.choose.cursor": "Needs a public HTTPS address",
    "use.choose.openaiSdk": "Python; Chat Completions and Responses",
    "use.choose.anthropicSdk": "Python; the Messages API",
    "use.choose.curl": "List the models from a shell",

    "use.settings.key": "Client key",
    "use.settings.keyHint": "The setup below sends this key.",
    "use.settings.model": "Model",
    "use.settings.checking": "Checking the models this key reaches…",
    "use.settings.modelCount": "{count, plural, one {# model} other {# models}} for this key.",
    "use.settings.noModels": "No models yet. Connect an account first.",
    "use.settings.modelsFailed": "Could not list the models. The next step tests the key.",
    "use.settings.localTitle": "Works only on this computer",
    "use.settings.localDescription":
      "Other machines need this server's network address, and cloud services such as Cursor need a public HTTPS address.",
    "use.settings.copy": "Copy",
    "use.settings.copied": "Copied, with the full key.",
    "use.settings.copyFailed": "Could not copy the setup.",
    "use.settings.copyNote": "The copy includes the full key; the dialog shows it shortened.",

    "use.test.address": "Address",
    "use.test.key": "Client key",
    "use.test.testing": "Testing the connection…",
    "use.test.testingDescription":
      "Asking this proxy for its models with the key, as a tool would.",
    "use.test.ready": "Connection works",
    "use.test.readyDescription":
      "This key reaches {count, plural, one {# model} other {# models}}.",
    "use.test.noModels": "The key works, but no models are available yet",
    "use.test.noModelsDescription": "Connect an account first.",
    "use.test.failed": "Connection failed",
    "use.test.again": "Test again",

    "use.empty.title": "No client key yet",
    "use.empty.description":
      "Tools need a client key, a password they send to this proxy. Create one here and manage it under Client keys.",
    "use.empty.create": "Create a client key",
    "use.empty.created": "Client key created.",

    "use.note.claudeCode":
      "Run these in the shell you start Claude Code from. To keep them, put both variables in the env block of ~/.claude/settings.json. /status in Claude Code shows the address in use.",
    "use.note.codexCli": "Add the provider to ~/.codex/config.toml and set the key in your shell.",
    "use.note.cursor":
      "Cursor sends requests from its own servers, so the proxy needs a public HTTPS address, for example through a Cloudflare tunnel. Enter both values under Cursor Settings, Models.",
    "use.note.openaiSdk":
      "Python. The JavaScript SDK takes the same baseURL and apiKey. Chat Completions and Responses both work.",
    "use.note.anthropicSdk": "Python. The address has no /v1 here: the SDK adds it.",
    "use.note.curl":
      "Lists the models your connected accounts can serve. A 401 answer means the key is wrong.",
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
    "use.choose.claudeCode": "为 claude 命令设置两个环境变量",
    "use.choose.codexCli": "在 ~/.codex/config.toml 中添加提供商",
    "use.choose.cursor": "需要公网 HTTPS 地址",
    "use.choose.openaiSdk": "Python，支持 Chat Completions 和 Responses",
    "use.choose.anthropicSdk": "Python，使用 Messages API",
    "use.choose.curl": "在 shell 中列出模型",

    "use.settings.key": "客户端密钥",
    "use.settings.keyHint": "下方配置使用此密钥。",
    "use.settings.model": "模型",
    "use.settings.checking": "正在查询此密钥可用的模型…",
    "use.settings.modelCount": "此密钥可用 {count, plural, other {# 个模型}}。",
    "use.settings.noModels": "暂无可用模型，请先连接账号。",
    "use.settings.modelsFailed": "无法列出模型，下一步会测试此密钥。",
    "use.settings.localTitle": "仅限本机使用",
    "use.settings.localDescription":
      "其他设备需要使用此服务器的网络地址，Cursor 等云服务需要公网 HTTPS 地址。",
    "use.settings.copy": "复制",
    "use.settings.copied": "已复制，包含完整密钥",
    "use.settings.copyFailed": "无法复制配置",
    "use.settings.copyNote": "复制的内容包含完整密钥，对话框中的密钥已缩短显示。",

    "use.test.address": "地址",
    "use.test.key": "客户端密钥",
    "use.test.testing": "正在测试连接…",
    "use.test.testingDescription": "像工具一样用此密钥向代理查询模型列表。",
    "use.test.ready": "连接正常",
    "use.test.readyDescription": "此密钥可访问 {count, plural, other {# 个模型}}。",
    "use.test.noModels": "密钥可用，但暂无可用模型",
    "use.test.noModelsDescription": "请先连接账号。",
    "use.test.failed": "连接失败",
    "use.test.again": "重新测试",

    "use.empty.title": "还没有客户端密钥",
    "use.empty.description":
      "工具需要客户端密钥才能连接此代理。在此创建，之后到客户端密钥页面管理。",
    "use.empty.create": "创建客户端密钥",
    "use.empty.created": "已创建客户端密钥",

    "use.note.claudeCode":
      "在启动 Claude Code 的 shell 中执行这些命令。要长期生效，把两个变量写入 ~/.claude/settings.json 的 env 块。在 Claude Code 中运行 /status 可查看当前使用的地址。",
    "use.note.codexCli": "将提供商添加到 ~/.codex/config.toml，并在 shell 中设置密钥。",
    "use.note.cursor":
      "Cursor 从自己的服务器发出请求，所以代理需要公网 HTTPS 地址，例如通过 Cloudflare Tunnel。在 Cursor Settings 的 Models 中填写这两个值。",
    "use.note.openaiSdk":
      "Python 示例。JavaScript SDK 使用相同的 baseURL 和 apiKey。Chat Completions 和 Responses 都可用。",
    "use.note.anthropicSdk": "Python 示例。这里的地址不带 /v1，SDK 会自动补上。",
    "use.note.curl": "列出已连接账号可提供的模型。返回 401 表示密钥有误。",
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
    "use.choose.claudeCode": "為 claude 指令設定兩個環境變數",
    "use.choose.codexCli": "在 ~/.codex/config.toml 中加入供應商",
    "use.choose.cursor": "需要公開的 HTTPS 位址",
    "use.choose.openaiSdk": "Python，支援 Chat Completions 與 Responses",
    "use.choose.anthropicSdk": "Python，使用 Messages API",
    "use.choose.curl": "在 shell 中列出模型",

    "use.settings.key": "用戶端金鑰",
    "use.settings.keyHint": "下方設定使用此金鑰。",
    "use.settings.model": "模型",
    "use.settings.checking": "正在查詢此金鑰可用的模型…",
    "use.settings.modelCount": "此金鑰可用 {count, plural, other {# 個模型}}。",
    "use.settings.noModels": "目前沒有可用模型，請先連接帳號。",
    "use.settings.modelsFailed": "無法列出模型，下一步會測試此金鑰。",
    "use.settings.localTitle": "僅限本機使用",
    "use.settings.localDescription":
      "其他裝置需要使用此伺服器的網路位址，Cursor 等雲端服務需要公開的 HTTPS 位址。",
    "use.settings.copy": "複製",
    "use.settings.copied": "已複製，包含完整金鑰",
    "use.settings.copyFailed": "無法複製設定",
    "use.settings.copyNote": "複製的內容包含完整金鑰，對話框中的金鑰已縮短顯示。",

    "use.test.address": "位址",
    "use.test.key": "用戶端金鑰",
    "use.test.testing": "正在測試連線…",
    "use.test.testingDescription": "像工具一樣用此金鑰向代理查詢模型清單。",
    "use.test.ready": "連線正常",
    "use.test.readyDescription": "此金鑰可存取 {count, plural, other {# 個模型}}。",
    "use.test.noModels": "金鑰可用，但目前沒有可用模型",
    "use.test.noModelsDescription": "請先連接帳號。",
    "use.test.failed": "連線失敗",
    "use.test.again": "重新測試",

    "use.empty.title": "還沒有用戶端金鑰",
    "use.empty.description":
      "工具需要用戶端金鑰才能連線到此代理。在此建立，之後到用戶端金鑰頁面管理。",
    "use.empty.create": "建立用戶端金鑰",
    "use.empty.created": "已建立用戶端金鑰",

    "use.note.claudeCode":
      "在啟動 Claude Code 的 shell 中執行這些指令。要長期生效，請把兩個變數寫入 ~/.claude/settings.json 的 env 區塊。在 Claude Code 中執行 /status 可查看目前使用的位址。",
    "use.note.codexCli": "將供應商加入 ~/.codex/config.toml，並在 shell 中設定金鑰。",
    "use.note.cursor":
      "Cursor 從自己的伺服器送出請求，所以代理需要公開的 HTTPS 位址，例如透過 Cloudflare Tunnel。在 Cursor Settings 的 Models 中填入這兩個值。",
    "use.note.openaiSdk":
      "Python 範例。JavaScript SDK 使用相同的 baseURL 與 apiKey。Chat Completions 與 Responses 都可用。",
    "use.note.anthropicSdk": "Python 範例。這裡的位址不含 /v1，SDK 會自動補上。",
    "use.note.curl": "列出已連接帳號可提供的模型。回傳 401 表示金鑰有誤。",
  },
};
