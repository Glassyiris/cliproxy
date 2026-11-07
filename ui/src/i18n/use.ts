export default {
  en: {
    "use.page.title": "Use with tools",
    "use.page.description":
      "Speaks the OpenAI, Anthropic and Gemini APIs with the accounts you connected",
    "use.page.what": "client keys",

    "use.address.heading": "1. Address and key",
    "use.address.proxy": "Proxy address",
    "use.address.openai": "OpenAI-style base URL",
    "use.address.copy": "Copy address",
    "use.address.copied": "Address copied.",
    "use.address.copyFailed": "Could not copy the address.",
    "use.address.localTitle": "Works only on this computer",
    "use.address.localDescription":
      "Other machines need this server's network address, and cloud services such as Cursor need a public HTTPS address.",
    "use.address.key": "Client key",
    "use.address.model": "Model",

    "use.test.testing": "Testing the key…",
    "use.test.ready": "Working. This key reaches {count, plural, one {# model} other {# models}}.",
    "use.test.noModels":
      "The key works, but no models are available yet. Connect an account first.",
    "use.test.again": "Test again",

    "use.empty.title": "No client key yet",
    "use.empty.description":
      "Tools need a client key, a password they send to this proxy. Create one here and manage it under Client keys.",
    "use.empty.create": "Create a client key",
    "use.empty.created": "Client key created.",

    "use.tool.heading": "2. Set up a tool",
    "use.tool.label": "Tool",
    "use.tool.copy": "Copy",
    "use.tool.copied": "Copied, with the full key.",
    "use.tool.copyFailed": "Could not copy the setup.",
    "use.tool.copyNote": "The copy includes the full key; the page shows it shortened.",

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
    "use.page.title": "接入工具",
    "use.page.description": "使用已连接的账号提供 OpenAI、Anthropic 和 Gemini API",
    "use.page.what": "客户端密钥",

    "use.address.heading": "1. 地址与密钥",
    "use.address.proxy": "代理地址",
    "use.address.openai": "OpenAI 风格的基础 URL",
    "use.address.copy": "复制地址",
    "use.address.copied": "已复制地址",
    "use.address.copyFailed": "无法复制地址",
    "use.address.localTitle": "仅限本机使用",
    "use.address.localDescription":
      "其他设备需要使用此服务器的网络地址，Cursor 等云服务需要公网 HTTPS 地址。",
    "use.address.key": "客户端密钥",
    "use.address.model": "模型",

    "use.test.testing": "正在测试密钥…",
    "use.test.ready": "可用，此密钥可访问 {count, plural, other {# 个模型}}。",
    "use.test.noModels": "密钥可用，但暂无可用模型。请先连接账号。",
    "use.test.again": "重新测试",

    "use.empty.title": "还没有客户端密钥",
    "use.empty.description":
      "工具需要客户端密钥才能连接此代理。在此创建，之后到客户端密钥页面管理。",
    "use.empty.create": "创建客户端密钥",
    "use.empty.created": "已创建客户端密钥",

    "use.tool.heading": "2. 配置工具",
    "use.tool.label": "工具",
    "use.tool.copy": "复制",
    "use.tool.copied": "已复制，包含完整密钥",
    "use.tool.copyFailed": "无法复制配置",
    "use.tool.copyNote": "复制的内容包含完整密钥，页面上的密钥已缩短显示。",

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
    "use.page.title": "串接工具",
    "use.page.description": "使用已連接的帳號提供 OpenAI、Anthropic 與 Gemini API",
    "use.page.what": "用戶端金鑰",

    "use.address.heading": "1. 位址與金鑰",
    "use.address.proxy": "代理位址",
    "use.address.openai": "OpenAI 風格的基礎 URL",
    "use.address.copy": "複製位址",
    "use.address.copied": "已複製位址",
    "use.address.copyFailed": "無法複製位址",
    "use.address.localTitle": "僅限本機使用",
    "use.address.localDescription":
      "其他裝置需要使用此伺服器的網路位址，Cursor 等雲端服務需要公開的 HTTPS 位址。",
    "use.address.key": "用戶端金鑰",
    "use.address.model": "模型",

    "use.test.testing": "正在測試金鑰…",
    "use.test.ready": "可用，此金鑰可存取 {count, plural, other {# 個模型}}。",
    "use.test.noModels": "金鑰可用，但目前沒有可用模型。請先連接帳號。",
    "use.test.again": "重新測試",

    "use.empty.title": "還沒有用戶端金鑰",
    "use.empty.description":
      "工具需要用戶端金鑰才能連線到此代理。在此建立，之後到用戶端金鑰頁面管理。",
    "use.empty.create": "建立用戶端金鑰",
    "use.empty.created": "已建立用戶端金鑰",

    "use.tool.heading": "2. 設定工具",
    "use.tool.label": "工具",
    "use.tool.copy": "複製",
    "use.tool.copied": "已複製，包含完整金鑰",
    "use.tool.copyFailed": "無法複製設定",
    "use.tool.copyNote": "複製的內容包含完整金鑰，頁面上的金鑰已縮短顯示。",

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
