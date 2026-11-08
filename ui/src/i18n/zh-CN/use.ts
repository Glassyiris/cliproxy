export default {
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
};
