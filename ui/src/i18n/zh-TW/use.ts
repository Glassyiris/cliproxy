export default {
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
