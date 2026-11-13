// Every area's zh-TW messages. i18n.ts imports this on demand, so they load as one chunk, only when
// the dashboard is shown in zh-TW.
import app from "./app.ts";
import overview from "./overview.ts";
import use from "./use.ts";
import accounts from "./accounts.ts";
import providers from "./providers.ts";
import keys from "./keys.ts";
import models from "./models.ts";
import payload from "./payload.ts";
import usage from "./usage.ts";
import logs from "./logs.ts";
import config from "./config.ts";
import connect from "./connect.ts";
import system from "./system.ts";

export default {
  ...app["zh-TW"],
  ...overview["zh-TW"],
  ...use["zh-TW"],
  ...accounts["zh-TW"],
  ...providers["zh-TW"],
  ...keys["zh-TW"],
  ...models["zh-TW"],
  ...payload["zh-TW"],
  ...usage["zh-TW"],
  ...logs["zh-TW"],
  ...config["zh-TW"],
  ...connect["zh-TW"],
  ...system["zh-TW"],
};
