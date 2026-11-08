import { t } from "../../lib/i18n.ts";
import type { Phase } from "./flow.ts";

const words: Record<Phase, () => string> = {
  wait: () => t("connect.phase.wait"),
  verifying: () => t("connect.phase.verifying"),
  ok: () => t("connect.phase.ok"),
  refused: () => t("connect.phase.refused"),
  error: () => t("connect.phase.error"),
  unknown: () => t("connect.phase.unknown"),
  cancelled: () => t("connect.phase.cancelled"),
};

export const phaseWord = (phase: Phase) => words[phase]();
