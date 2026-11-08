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
};
