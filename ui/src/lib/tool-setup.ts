export const tools = ["Claude Code", "Codex CLI", "Cursor", "OpenAI SDK", "Anthropic SDK", "curl"] as const;
/** A POSIX shell single-quoted literal: nothing inside is expanded. */
const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
/** A shell word, quoted only when it holds characters the shell would interpret. */
const shw = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : shq(s));
/** A double-quoted string that Python and TOML read back unchanged (JSON escapes are valid in both). */
const str = (s: string) => JSON.stringify(s);
/**
 * Setup text for one tool, pointed at this server (base has no trailing slash). Values are
 * quoted for the language they land in, so a key holding $, quotes or backslashes pastes intact.
 */
export function snippet(tool: (typeof tools)[number], base: string, key: string, model: string): string {
  const v1 = `${base}/v1`;
  switch (tool) {
    case "Claude Code":
      return `export ANTHROPIC_BASE_URL=${shw(base)}\nexport ANTHROPIC_AUTH_TOKEN=${shq(key)}\nclaude`;
    case "Codex CLI":
      return `# ~/.codex/config.toml\nmodel_provider = "cliproxy"\n\n[model_providers.cliproxy]\nname = "cliproxy"\nbase_url = ${str(v1)}\nenv_key = "CLIPROXY_API_KEY"\nwire_api = "responses"\n\n# then, in your shell\nexport CLIPROXY_API_KEY=${shq(key)}`;
    case "Cursor":
      return `OpenAI API key:            ${key}\nOverride OpenAI Base URL:  ${v1}`;
    case "OpenAI SDK":
      return `from openai import OpenAI\n\nclient = OpenAI(base_url=${str(v1)}, api_key=${str(key)})\nr = client.chat.completions.create(\n    model=${str(model)}, messages=[{"role": "user", "content": "Hello"}]\n)\nprint(r.choices[0].message.content)`;
    case "Anthropic SDK":
      return `import anthropic\n\nclient = anthropic.Anthropic(base_url=${str(base)}, api_key=${str(key)})\nr = client.messages.create(\n    model=${str(model)}, max_tokens=256, messages=[{"role": "user", "content": "Hello"}]\n)\nprint(r.content[0].text)`;
    default:
      return `curl ${shw(`${v1}/models`)} -H ${shq(`Authorization: Bearer ${key}`)}`;
  }
}
