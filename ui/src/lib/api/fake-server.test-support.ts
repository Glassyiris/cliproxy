// A fetch stand-in for API tests: records each request and answers from `answer`.
export type Sent = { method: string; url: URL; headers: Record<string, string>; body: unknown };

export function fakeServer() {
  const sent: Sent[] = [];
  const server = {
    sent,
    answer: (_: Sent): Response | Promise<Response> => Response.json({}),
  };
  Object.assign(globalThis, { location: { href: "http://cpa.test/management.html" } });
  globalThis.fetch = async (input, init = {}) => {
    const body = typeof init.body === "string" ? tryJson(init.body) : init.body;
    const s: Sent = {
      method: init.method ?? "GET",
      url: new URL(String(input)),
      headers: init.headers as Record<string, string>,
      body,
    };
    sent.push(s);
    if (init.signal?.aborted) throw init.signal.reason;
    return server.answer(s);
  };
  return server;
}

const tryJson = (text: string) => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};
