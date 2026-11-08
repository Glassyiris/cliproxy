import { t } from "../../lib/i18n.ts";
import { isRule, modelsOf, type Kind, type ParamsError, type RuleModel } from "./rules.ts";

const meanings: Record<Kind, () => string> = {
  default: () => t("payload.kind.default"),
  "default-raw": () => t("payload.kind.defaultRaw"),
  override: () => t("payload.kind.override"),
  "override-raw": () => t("payload.kind.overrideRaw"),
  filter: () => t("payload.kind.filter"),
};

export const kindMeaning = (kind: Kind) => meanings[kind]();

const paramsMessages: Record<ParamsError, () => string> = {
  invalid: () => t("payload.add.invalid"),
  notList: () => t("payload.add.notList"),
  notObject: () => t("payload.add.notObject"),
};

export const paramsMessage = (error: ParamsError) => paramsMessages[error]();

/** A model pattern with the protocol it is limited to, if any. */
export const modelWord = (model: RuleModel) =>
  model.protocol
    ? t("payload.row.withProtocol", { model: model.name, protocol: model.protocol })
    : model.name;

/** What an entry applies to, for the confirmation: its models, or that it cannot be read. */
export function entryLabel(entry: unknown) {
  if (!isRule(entry)) return t("payload.row.unreadable");
  return modelsOf(entry).map(modelWord).join(", ") || t("payload.row.noModels");
}
