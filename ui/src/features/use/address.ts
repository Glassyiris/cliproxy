/** Localhost, any 127.* address and ::1: a name only this computer can reach. */
export const isLocalHost = (hostname: string) =>
  /^(localhost|127(\.\d{1,3}){3}|\[?::1\]?)$/.test(hostname);

const publicPlaceholder = "https://your-public-address";

/** Cursor calls the proxy from its own servers, so a local address cannot work there. */
export const toolTarget = (tool: string, base: string, local: boolean) =>
  tool === "Cursor" && local ? publicPlaceholder : base;
