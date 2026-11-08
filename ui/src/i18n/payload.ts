export default {
  en: {
    "payload.page.title": "Payload rules",
    "payload.page.what": "payload rules",
    "payload.page.add": "Add rule",

    "payload.group.storedNotList":
      "The stored {kind} value is not a list, so rules cannot be added to it.",
    "payload.row.remove": "Remove",
    "payload.row.unreadable": "Unreadable entry",
    "payload.row.noModels": "no models",

    "payload.kind.default": "Set a value the request lacks.",
    "payload.kind.defaultRaw": "Default, with raw JSON values.",
    "payload.kind.override": "Always set the value.",
    "payload.kind.overrideRaw": "Override, with raw JSON values.",
    "payload.kind.filter": "Remove paths from the request.",

    "payload.empty.title": "No payload rules",

    "payload.add.title": "Add payload rule",
    "payload.add.kind": "Kind",
    "payload.add.model": "Model pattern",
    "payload.add.modelRequired": "Enter a model pattern.",
    "payload.add.protocol": "Protocol",
    "payload.add.anyProtocol": "Any",
    "payload.add.valuesObject": "Values, as a JSON object of path → value",
    "payload.add.valuesList": "Paths, as a JSON list",
    "payload.add.invalid": "Enter valid JSON.",
    "payload.add.notList": "A filter takes a JSON list of paths.",
    "payload.add.notObject": "This kind takes a JSON object of path → value.",
    "payload.add.submit": "Add rule",
    "payload.add.added": "Rule added.",

    "payload.remove.removed": "Rule removed.",
    "payload.remove.title": "Remove this {kind} rule?",
    "payload.remove.description":
      "Applies to: {models}. Requests to these models are no longer changed by it.",
    "payload.remove.action": "Remove",
    "payload.page.meta":
      "{rules, plural, one {# rule} other {# rules}} for {models, plural, one {# model} other {# models}}",
    "payload.page.search": "Search models",
    "payload.col.pattern": "Model pattern",
    "payload.col.kind": "Action",
    "payload.col.fields": "Fields",
    "payload.col.actions": "Actions",
    "payload.group.noModels": "No model",
    "payload.row.summary": "{kind}: {count, plural, one {# field} other {# fields}}",
    "payload.row.withProtocol": "{model} ({protocol})",
    "payload.empty.noMatch": "No rules match",
    "payload.empty.clear": "Clear search",
    "payload.panel.label": "Payload rule",
    "payload.panel.close": "Close details",
    "payload.panel.models": "Models",
    "payload.panel.editHint": "Rules are edited in the config file.",
  },
};
