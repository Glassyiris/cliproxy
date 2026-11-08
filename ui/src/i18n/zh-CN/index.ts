// Every area's zh-CN messages. i18n.ts imports this on demand, so they load as one chunk, only when
// the dashboard is shown in zh-CN.
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
import plugins from "./plugins.ts";
import connect from "./connect.ts";
import system from "./system.ts";

export default {
  ...app["zh-CN"],
  ...overview["zh-CN"],
  ...use["zh-CN"],
  ...accounts["zh-CN"],
  ...providers["zh-CN"],
  ...keys["zh-CN"],
  ...models["zh-CN"],
  ...payload["zh-CN"],
  ...usage["zh-CN"],
  ...logs["zh-CN"],
  ...config["zh-CN"],
  ...plugins["zh-CN"],
  ...connect["zh-CN"],
  ...system["zh-CN"],
};
