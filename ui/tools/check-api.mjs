// Compares the Management API registry (src/lib/api/routes.ts) with the routes the Rust
// router registers under /v8/management and /admin/v1. Fails when the registry names a route the server
// lacks, or the server has a route that is neither in the registry nor allowlisted with a
// reason in tools/api-allowlist.json. The keyless routes in `publicRoutes` must each appear as a
// `.route("<path>", get(..))` in crates/cpa-server/src/lib.rs; the server's other public routes
// (the proxy itself) have no dashboard caller and are not compared.
//
// The router is read by evaluating the small subset of Rust that `fn router` is written in:
// string bindings, format!, closures, local fns, `for` over tuple arrays, `if a == b`, and
// method chains on MethodRouter and Router. Anything else exits 2 instead of being guessed.
//
// Exit codes: 0 in step, 1 mismatch, 2 cannot read or parse an input.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ui = fileURLToPath(new URL("..", import.meta.url));
const rustFile = fileURLToPath(new URL("../../crates/cpa-server/src/management.rs", import.meta.url));
const libFile = fileURLToPath(new URL("../../crates/cpa-server/src/lib.rs", import.meta.url));
const allowFile = fileURLToPath(new URL("./api-allowlist.json", import.meta.url));
const PREFIX = "/v8/management";
const ADMIN_PREFIX = "/admin/v1";
const VERBS = { get: "GET", post: "POST", put: "PUT", patch: "PATCH", delete: "DELETE" };
// Router and MethodRouter calls that add no route rows. HEAD and `any` go to the
// not-found fallback, so they are not rows either.
const PASS = new Set(["layer", "route_layer", "with_state", "fallback", "clone", "head", "options"]);

class ParseError extends Error {}
const fail = (message) => {
  throw new ParseError(message);
};

function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) i++;
    else if (src.startsWith("//", i)) i = src.indexOf("\n", i) === -1 ? src.length : src.indexOf("\n", i);
    else if (src.startsWith("/*", i)) i = src.indexOf("*/", i) + 2;
    else if (c === "'") {
      // A char literal is skipped whole so a quote inside it cannot open a string; a lifetime is one token.
      const m = /^'(?:\\.[^']*|[^'\\])'/.exec(src.slice(i, i + 12));
      if (!m) out.push({ k: "op", v: "'" });
      i += m ? m[0].length : 1;
    } else if (/^b?r#*"/.test(src.slice(i, i + 8)) && !/[A-Za-z0-9_]/.test(src[i - 1] ?? "")) {
      const m = /^b?r(#*)"/.exec(src.slice(i, i + 8));
      const end = src.indexOf(`"${m[1]}`, i + m[0].length);
      if (end < 0) fail("unterminated raw string");
      out.push({ k: "str", v: src.slice(i + m[0].length, end) });
      i = end + 1 + m[1].length;
    } else if (c === '"') {
      let j = i + 1,
        v = "";
      while (src[j] !== '"') {
        if (j >= src.length) fail("unterminated string");
        if (src[j] === "\\") v += JSON.parse(`"${src[j] + src[j + 1]}"`), (j += 2);
        else v += src[j++];
      }
      out.push({ k: "str", v });
      i = j + 1;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i, i + 200));
      out.push({ k: "id", v: m[0] });
      i += m[0].length;
    } else if (/[0-9]/.test(c)) {
      const m = /^[0-9_]+/.exec(src.slice(i, i + 50));
      out.push({ k: "num", v: m[0] });
      i += m[0].length;
    } else {
      const two = src.slice(i, i + 2);
      const op = ["::", "==", "||", "&&", "->", "=>"].includes(two) ? two : c;
      out.push({ k: "op", v: op });
      i += op.length;
    }
  }
  return out;
}

/** The body tokens of `fn name`, without the outer braces. */
function fnBody(tokens, name) {
  const at = tokens.findIndex((t, i) => t.v === "fn" && tokens[i + 1]?.v === name && tokens[i + 2]?.v === "(");
  if (at < 0) fail(`fn ${name} not found`);
  let i = at;
  while (tokens[i].v !== "{") i++;
  const end = closing(tokens, i);
  return tokens.slice(i + 1, end);
}

function closing(tokens, open) {
  const pairs = { "{": "}", "(": ")", "[": "]" };
  const stack = [];
  for (let i = open; i < tokens.length; i++) {
    const v = tokens[i].k === "op" ? tokens[i].v : null;
    if (pairs[v]) stack.push(pairs[v]);
    else if (v && v === stack.at(-1)) {
      stack.pop();
      if (!stack.length) return i;
    }
  }
  fail("unbalanced brackets");
}

class Parser {
  constructor(tokens) {
    this.t = tokens;
    this.i = 0;
  }
  peek(o = 0) {
    return this.t[this.i + o];
  }
  is(v, o = 0) {
    return this.peek(o)?.v === v && this.peek(o).k !== "str";
  }
  eat(v) {
    if (!this.is(v)) fail(`expected ${v}, found ${this.peek()?.v ?? "end"}`);
    return this.t[this.i++];
  }
  done() {
    return this.i >= this.t.length;
  }
  block() {
    this.eat("{");
    const end = closing(this.t, this.i - 1);
    const inner = new Parser(this.t.slice(this.i, end));
    this.i = end + 1;
    return inner.statements();
  }
  statements() {
    const out = [];
    while (!this.done()) {
      if (this.is("let")) {
        this.eat("let");
        if (this.is("mut")) this.eat("mut");
        const pattern = this.pattern();
        while (!this.is("=")) this.i++;
        this.eat("=");
        out.push({ s: "let", pattern, value: this.expr() });
        this.eat(";");
      } else if (this.is("for")) {
        this.eat("for");
        const pattern = this.pattern();
        this.eat("in");
        const start = this.i;
        const iter = this.expr();
        const body = this.block();
        out.push({ s: "for", pattern, iter, body, tokens: this.t.slice(start, this.i) });
      } else if (this.is("if")) {
        this.eat("if");
        const cond = this.expr();
        const then = this.block();
        let otherwise = [];
        if (this.is("else")) this.eat("else"), (otherwise = this.block());
        out.push({ s: "if", cond, then, otherwise });
      } else if (this.peek().k === "id" && this.is("=", 1)) {
        const name = this.t[this.i].v;
        this.i += 2;
        out.push({ s: "set", name, value: this.expr() });
        this.eat(";");
      } else {
        const value = this.expr();
        if (this.is(";")) this.eat(";"), out.push({ s: "expr", value });
        else if (this.done()) out.push({ s: "return", value });
        else fail(`unexpected ${this.peek().v} after an expression`);
      }
    }
    return out;
  }
  pattern() {
    if (this.is("(")) {
      this.eat("(");
      const names = [];
      while (!this.is(")")) {
        names.push(this.eat(this.peek().v).v);
        if (this.is(",")) this.eat(",");
      }
      this.eat(")");
      return names;
    }
    return this.eat(this.peek().v).v;
  }
  list(close) {
    const items = [];
    while (!this.is(close)) {
      items.push(this.expr());
      if (this.is(",")) this.eat(",");
      else break;
    }
    this.eat(close);
    return items;
  }
  expr() {
    const left = this.postfix();
    if (this.is("==")) {
      this.eat("==");
      return { e: "eq", left, right: this.postfix() };
    }
    return left;
  }
  postfix() {
    let node = this.primary();
    for (;;) {
      if (this.is(".")) {
        this.eat(".");
        const name = this.eat(this.peek().v).v;
        if (!this.is("(")) fail(`field access .${name} is not supported`);
        this.eat("(");
        node = { e: "method", target: node, name, args: this.list(")") };
      } else if (this.is("(")) {
        this.eat("(");
        node = { e: "call", callee: node, args: this.list(")") };
      } else return node;
    }
  }
  primary() {
    const tok = this.peek();
    if (!tok) fail("unexpected end of input");
    if (tok.k === "str") return this.i++, { e: "str", v: tok.v };
    if (tok.k === "num") return this.i++, { e: "opaque" };
    if (this.is("&")) return this.eat("&"), this.postfix();
    if (this.is("||")) {
      this.eat("||");
      return { e: "closure", body: this.is("{") ? this.block() : [{ s: "return", value: this.expr() }] };
    }
    if (this.is("[")) return this.eat("["), { e: "array", items: this.list("]") };
    if (this.is("(")) {
      this.eat("(");
      const items = this.list(")");
      return items.length === 1 ? items[0] : { e: "tuple", items };
    }
    if (tok.k === "id") {
      const path = [this.eat(tok.v).v];
      while (this.is("::")) this.eat("::"), path.push(this.eat(this.peek().v).v);
      if (this.is("!")) {
        this.eat("!");
        const open = this.i;
        const end = closing(this.t, open);
        const inner = this.t.slice(open + 1, end);
        this.i = end + 1;
        return { e: "macro", name: path.join("::"), inner };
      }
      return { e: "path", path };
    }
    fail(`unexpected token ${tok.v}`);
  }
}

const methodSet = (verbs = []) => ({ t: "methods", verbs });

class Evaluator {
  constructor(tokens) {
    this.tokens = tokens;
  }
  run(statements, env) {
    for (const st of statements) {
      if (st.s === "let") this.bind(st.pattern, this.eval(st.value, env), env);
      else if (st.s === "set") {
        let owner = env;
        while (owner && !Object.hasOwn(owner, st.name)) owner = Object.getPrototypeOf(owner);
        if (!owner) fail(`assignment to unknown ${st.name}`);
        owner[st.name] = this.eval(st.value, env);
      } else if (st.s === "expr") this.eval(st.value, env);
      else if (st.s === "return") return this.eval(st.value, env);
      else if (st.s === "if") {
        const cond = this.eval(st.cond, env);
        if (cond.t !== "bool") fail("an if condition that is not a string comparison");
        this.run(cond.v ? st.then : st.otherwise, env);
      } else if (st.s === "for") this.loop(st, env);
    }
    return { t: "unit" };
  }
  loop(st, env) {
    const iter = this.eval(st.iter, env);
    if (iter.t === "array") {
      for (const item of iter.items) {
        const scope = Object.create(env);
        this.bind(st.pattern, item, scope);
        this.run(st.body, scope);
      }
      return;
    }
    // A loop over a constant defined elsewhere is skipped only when every route it
    // registers is outside the management and admin APIs.
    const formats = st.tokens.flatMap((t, i) =>
      t.v === "format" && st.tokens[i + 1]?.v === "!" && st.tokens[i + 3]?.k === "str" ? [st.tokens[i + 3].v] : [],
    );
    const outside = formats.every((f) => {
      const m = /^\{(\w+)\}/.exec(f);
      const head = m && env[m[1]];
      return head?.t === "str" && ![PREFIX, ADMIN_PREFIX].some((prefix) => head.v.startsWith(prefix));
    });
    if (!formats.length || !outside) fail(`cannot expand a loop over ${describe(st.iter)}`);
  }
  bind(pattern, value, env) {
    if (typeof pattern === "string") {
      if (pattern !== "_") env[pattern] = value;
      return;
    }
    if (value.t !== "tuple" || value.items.length !== pattern.length) fail("tuple pattern does not match");
    pattern.forEach((name, i) => this.bind(name, value.items[i], env));
  }
  eval(node, env) {
    switch (node.e) {
      case "str":
        return { t: "str", v: node.v };
      case "opaque":
        return { t: "opaque" };
      case "array":
        return { t: "array", items: node.items.map((n) => this.eval(n, env)) };
      case "tuple":
        return { t: "tuple", items: node.items.map((n) => this.eval(n, env)) };
      case "closure":
        return { t: "closure", body: node.body, env };
      case "eq": {
        const [a, b] = [this.eval(node.left, env), this.eval(node.right, env)];
        if (a.t !== "str" || b.t !== "str") fail("== between values that are not strings");
        return { t: "bool", v: a.v === b.v };
      }
      case "path": {
        const name = node.path.join("::");
        if (node.path.length === 1 && name in env) return env[name];
        return { t: "external", name };
      }
      case "macro":
        return node.name === "format" ? this.format(node.inner, env) : { t: "opaque" };
      case "call":
        return this.call(node, env);
      case "method":
        return this.method(node, env);
    }
    fail(`cannot evaluate ${node.e}`);
  }
  format(inner, env) {
    if (inner[0]?.k !== "str") fail("format! without a literal");
    if (inner.length > 1) fail("format! with positional arguments");
    const v = inner[0].v.replace(/\{\{|\}\}|\{(\w+)\}/g, (m, name) => {
      if (m === "{{") return "{";
      if (m === "}}") return "}";
      const value = env[name];
      if (value?.t !== "str") fail(`format! reads ${name}, which is not a string`);
      return value.v;
    });
    return { t: "str", v };
  }
  call(node, env) {
    const callee = node.callee;
    if (callee.e === "path") {
      const name = callee.path.join("::");
      if (name === "Router::new") return { t: "router", rows: [] };
      if (name === "any") return methodSet();
      if (VERBS[name]) return methodSet([VERBS[name]]);
      if (callee.path.length === 1 && env[name]?.t === "closure") return this.run(env[name].body, Object.create(env[name].env));
      if (callee.path.length === 1 && !(name in env)) return this.run(new Parser(fnBody(this.tokens, name)).statements(), {});
    }
    fail(`cannot call ${describe(callee)}`);
  }
  method(node, env) {
    const target = this.eval(node.target, env);
    const name = node.name;
    if (target.t === "methods") {
      if (VERBS[name]) return methodSet([...target.verbs, VERBS[name]]);
      if (PASS.has(name)) return target;
    }
    if (target.t === "router") {
      if (name === "route") {
        const [path, methods] = node.args.map((a) => this.eval(a, env));
        if (path?.t !== "str" || methods?.t !== "methods") fail("route() without a literal path and a method router");
        return { t: "router", rows: [...target.rows, ...methods.verbs.map((method) => ({ method, path: path.v }))] };
      }
      if (PASS.has(name)) return target;
      fail(`Router::${name} is not supported; extend tools/check-api.mjs to follow it`);
    }
    if (target.t === "opaque" && PASS.has(name)) return target;
    fail(`cannot call .${name} on ${target.t}`);
  }
}

const describe = (node) => (node.e === "path" ? node.path.join("::") : node.e);
const key = (r) => `${r.method} ${r.path.replace(/^\/admin\/v1\/r\/(?:setting|provider|client-key|router|plugin)$/, "/admin/v1/r/{kind}")}`;

function serverRoutes() {
  const tokens = tokenize(readFileSync(rustFile, "utf8"));
  const statements = new Parser(fnBody(tokens, "router")).statements();
  const result = new Evaluator(tokens).run(statements, {});
  if (result.t !== "router") fail("fn router does not end in a Router");
  return result.rows
    .filter((r) => [PREFIX, ADMIN_PREFIX].some((prefix) => r.path.startsWith(`${prefix}/`)))
    .map((r) => ({ method: r.method, path: r.path.startsWith(`${PREFIX}/`) ? r.path.slice(PREFIX.length) : r.path }));
}

// Every `.route("<path>", get(` in lib.rs. A keyless dashboard route is a GET; the server's
// other routes (the proxy itself) have no dashboard caller and need no registry entry.
function publicServerRoutes() {
  const source = readFileSync(libFile, "utf8");
  const rows = [...source.matchAll(/\.route\(\s*"([^"]+)"\s*,\s*get\(/g)].map((m) => ({
    method: "GET",
    path: m[1],
  }));
  if (!rows.length) fail("no .route(\"..\", get(..)) calls found in lib.rs");
  return rows;
}

function publicProblems(registry, server) {
  const have = new Set(server.map(key));
  const problems = [];
  for (const r of registry) {
    if ([PREFIX, ADMIN_PREFIX].some((prefix) => r.path.startsWith(prefix))) problems.push(`publicRoutes: ${r.name} is an authenticated route; move it to routes`);
    else if (!have.has(key(r))) problems.push(`publicRoutes: ${r.name} is ${key(r)}, which lib.rs does not route`);
  }
  return problems;
}

function loadAllowlist() {
  const list = JSON.parse(readFileSync(allowFile, "utf8"));
  if (!Array.isArray(list)) fail("api-allowlist.json is not an array");
  for (const line of list)
    if (typeof line?.method !== "string" || typeof line?.path !== "string" || !line?.reason?.trim())
      fail(`api-allowlist.json line without method, path and reason: ${JSON.stringify(line)}`);
  return list;
}

function callerProblems() {
  const problems = [];
  const root = `${ui}src/`;
  for (const file of readdirSync(root, { recursive: true })) {
    if (!/\.tsx?$/.test(file) || file === "lib/api/routes.ts") continue;
    const source = ts.createSourceFile(file, readFileSync(root + file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if (ts.isSpreadAssignment(node)) {
        const expression = node.expression;
        if ((ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) &&
            ts.isIdentifier(expression.expression) &&
            ["routes", "publicRoutes"].includes(expression.expression.text))
          problems.push(`${file}: do not spread a registered route; pass it unchanged`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return problems;
}

async function main() {
  let server, registry, allow, publicServer, publicRegistry, problems;
  try {
    server = serverRoutes();
    publicServer = publicServerRoutes();
    allow = loadAllowlist();
    const table = await import(`${ui}src/lib/api/routes.ts`);
    registry = Object.entries(table.routes).map(([name, r]) => ({ name, ...r }));
    publicRegistry = Object.entries(table.publicRoutes).map(([name, r]) => ({ name, ...r }));
    problems = callerProblems();
  } catch (e) {
    console.error(`check-api: cannot parse: ${e.message}`);
    return 2;
  }
  const have = new Set(server.map(key));
  const seen = new Map();
  for (const r of registry) {
    if (seen.has(key(r))) problems.push(`registry: ${r.name} and ${seen.get(key(r))} are both ${key(r)}`);
    seen.set(key(r), r.name);
    if (!have.has(key(r))) problems.push(`registry: ${r.name} is ${key(r)}, which the server does not route`);
  }
  const allowed = new Set();
  for (const a of allow) {
    if (allowed.has(key(a))) problems.push(`allowlist: ${key(a)} is listed twice`);
    allowed.add(key(a));
    if (!have.has(key(a))) problems.push(`allowlist: ${key(a)} is not a server route; remove the line`);
    if (seen.has(key(a))) problems.push(`allowlist: ${key(a)} is also in the registry as ${seen.get(key(a))}; remove the line`);
  }
  problems.push(...publicProblems(publicRegistry, publicServer));
  for (const r of server)
    if (!seen.has(key(r)) && !allowed.has(key(r)))
      problems.push(`server: ${key(r)} has no registry entry and no allowlist line with a reason`);
  if (problems.length) {
    for (const p of problems) console.error(`check-api: ${p}`);
    return 1;
  }
  console.log(`check-api: ${server.length} management/admin routes: ${registry.length} in the registry, ${allow.length} allowlisted; ${publicRegistry.length} keyless route(s) found in lib.rs`);
  return 0;
}

process.exitCode = await main();
