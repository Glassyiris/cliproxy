// i18n gate (REQUIREMENTS rows 10, 11). Catalogs are src/i18n/<area>.ts with
// `export default { en, "zh-CN", "zh-TW" }`, flat keys `<area>.<part>.<name>`, ICU messages.
// A catalog may also export `dynamicKeys`, the one allowlist of its keys that are looked up
// through a computed `t(...)` argument.
//
// Catalogs: same three locales and same keys; every message parses as ICU; argument names
//   match across locales; key shape and area prefix; zh-TW has no Simplified-only and zh-CN
//   no Traditional-only characters (opencc-js conversion must change nothing).
// Source: every t("key") literal exists; every key is used by a literal or by `dynamicKeys`;
//   a computed t(`prefix.${x}`) needs a literal prefix that some `dynamicKeys` entry extends,
//   and every `dynamicKeys` entry must be covered by such a call; no JSX text literal and no
//   literal aria-label, title, placeholder or alt in .tsx.
//
// Exit codes: 0 clean, 1 violation, 2 cannot run (a catalog cannot be loaded).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { IntlMessageFormat } from "intl-messageformat";
import { Converter } from "opencc-js";
import ts from "typescript";

// An optional argument points the gate at another ui/ directory (used to drive it red).
const ui = resolve(process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url)));
const srcDir = join(ui, "src");
const i18nDir = join(srcDir, "i18n");
const LOCALES = ["en", "zh-CN", "zh-TW"];
const KEY_SHAPE = /^([a-z][A-Za-z0-9]*)\.[a-z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*$/;
const TEXT_ATTRIBUTES = new Set(["aria-label", "title", "placeholder", "alt"]);
const HAS_TEXT = /[\p{L}\p{N}]/u;
const TEST_FILE = /\.test(?:-support)?\.tsx?$/;
// Product names that read the same in every locale and may stay in JSX.
const UNTRANSLATED = new Set(["cliproxy-rs"]);
// Characters OpenCC rewrites although Taiwan usage writes them as they are: 台灣, 了解.
const ALSO_TRADITIONAL = new Set(["台", "了"]);
const toTraditional = Converter({ from: "cn", to: "t" });
const toSimplified = Converter({ from: "t", to: "cn" });

const errors = [];
const fail = (where, message) => errors.push(`${where} ${message}`);

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? listFiles(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

// Walks an ICU AST and collects argument names; tags count because a tag is a function argument.
function argumentNames(nodes, into = new Set()) {
  for (const node of nodes) {
    if (node.type === 0 || node.type === 7) continue;
    into.add(node.value);
    if (node.options)
      for (const option of Object.values(node.options)) argumentNames(option.value, into);
    if (node.children) argumentNames(node.children, into);
  }
  return into;
}

function messageArguments(where, locale, message) {
  if (message === undefined) return undefined; // a missing key is reported by checkLocales
  if (typeof message !== "string" || message === "") {
    fail(where, `${locale}: message must be a non-empty string`);
    return undefined;
  }
  try {
    return argumentNames(new IntlMessageFormat(message, locale).getAst());
  } catch (error) {
    fail(where, `${locale}: not valid ICU: ${error instanceof Error ? error.message : error}`);
    return undefined;
  }
}

function conversionDiff(text, convert, ignore) {
  const converted = convert(text);
  if (converted.length !== text.length)
    return converted === text ? [] : [`"${text}" -> "${converted}"`];
  const found = [];
  for (let i = 0; i < text.length; i++)
    if (text[i] !== converted[i] && !ignore.has(text[i]))
      found.push(`${text[i]} -> ${converted[i]}`);
  return found;
}

function checkScript(where, locale, message) {
  if (typeof message !== "string") return;
  if (locale === "zh-TW") {
    const found = conversionDiff(message, toTraditional, ALSO_TRADITIONAL);
    if (found.length > 0) fail(where, `zh-TW has Simplified-only characters: ${found.join(", ")}`);
  }
  if (locale === "zh-CN") {
    const found = conversionDiff(message, toSimplified, new Set());
    if (found.length > 0) fail(where, `zh-CN has Traditional-only characters: ${found.join(", ")}`);
  }
}

function checkLocales(file, area, catalog) {
  const where = relative(ui, file);
  const present = Object.keys(catalog ?? {});
  if (present.length !== LOCALES.length || !LOCALES.every((locale) => present.includes(locale))) {
    fail(where, `default export must have exactly the locales ${LOCALES.join(", ")}`);
    return false;
  }
  const reference = new Set(Object.keys(catalog.en));
  for (const locale of LOCALES) {
    const keys = new Set(Object.keys(catalog[locale]));
    for (const key of reference) if (!keys.has(key)) fail(where, `${locale} lacks ${key}`);
    for (const key of keys) if (!reference.has(key)) fail(where, `${locale} has extra ${key}`);
  }
  for (const key of reference) {
    const shape = KEY_SHAPE.exec(key);
    if (!shape) fail(where, `${key}: key must be <area>.<part>.<name> in camelCase`);
    else if (shape[1] !== area) fail(where, `${key}: key must start with the area "${area}"`);
  }
  return true;
}

function checkMessages(file, catalog) {
  const where = relative(ui, file);
  for (const key of Object.keys(catalog.en)) {
    const names = LOCALES.map((locale) => {
      checkScript(`${where} ${key}`, locale, catalog[locale][key]);
      return messageArguments(`${where} ${key}`, locale, catalog[locale][key]);
    });
    if (names.some((set) => set === undefined)) continue;
    const reference = [...names[0]].sort().join(",");
    LOCALES.forEach((locale, index) => {
      const own = [...names[index]].sort().join(",");
      if (own !== reference)
        fail(`${where} ${key}`, `${locale} arguments {${own}} differ from en {${reference}}`);
    });
  }
}

async function loadCatalogs() {
  const catalogs = [];
  if (!existsSync(i18nDir)) return catalogs;
  const files = readdirSync(i18nDir)
    .filter((name) => name.endsWith(".ts") && !TEST_FILE.test(name))
    .sort();
  for (const name of files) {
    const file = join(i18nDir, name);
    let module;
    try {
      module = await import(pathToFileURL(file).href);
    } catch (error) {
      console.error(
        `check-i18n: cannot run: ${file}: ${error instanceof Error ? error.message : error}`,
      );
      process.exit(2);
    }
    const area = basename(name, ".ts");
    if (!checkLocales(file, area, module.default)) continue;
    checkMessages(file, module.default);
    const dynamic = module.dynamicKeys ?? [];
    for (const key of dynamic)
      if (!(key in module.default.en))
        fail(relative(ui, file), `dynamicKeys lists unknown key ${key}`);
    catalogs.push({ area, file, keys: Object.keys(module.default.en), dynamic });
  }
  return catalogs;
}

// Strings an expression can produce directly: a literal, a branch of ?:, the right side of
// && || ??, either side of +. A call such as t("x") produces none.
function literalStrings(node) {
  if (!node) return [];
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isTemplateExpression(node))
    return [node.head.text + node.templateSpans.map((s) => s.literal.text).join("")];
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node))
    return literalStrings(node.expression);
  if (ts.isConditionalExpression(node))
    return [...literalStrings(node.whenTrue), ...literalStrings(node.whenFalse)];
  if (!ts.isBinaryExpression(node)) return [];
  const operator = node.operatorToken.kind;
  if (operator === ts.SyntaxKind.PlusToken)
    return [...literalStrings(node.left), ...literalStrings(node.right)];
  const rightOnly = [
    ts.SyntaxKind.AmpersandAmpersandToken,
    ts.SyntaxKind.BarBarToken,
    ts.SyntaxKind.QuestionQuestionToken,
  ];
  return rightOnly.includes(operator) ? literalStrings(node.right) : [];
}

// The literal start of a computed key: `a.b.${x}` and "a.b." + x both give "a.b.".
function staticPrefix(node) {
  if (ts.isTemplateExpression(node)) return node.head.text;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
    return ts.isStringLiteralLike(node.left) ? node.left.text : "";
  return "";
}

function checkTranslateCall(node, usage, where) {
  const arg = node.arguments[0];
  if (!arg) return;
  if (ts.isStringLiteralLike(arg)) usage.literals.push({ key: arg.text, where });
  else usage.computed.push({ prefix: staticPrefix(arg), where });
}

function jsxLiteralProblems(node) {
  const found = [];
  if (ts.isJsxText(node)) {
    const text = node.text.trim();
    if (HAS_TEXT.test(text) && !UNTRANSLATED.has(text)) found.push(`JSX text "${text}"`);
  }
  if (ts.isJsxExpression(node) && !ts.isJsxAttribute(node.parent)) {
    for (const text of literalStrings(node.expression))
      if (HAS_TEXT.test(text) && !UNTRANSLATED.has(text.trim())) found.push(`JSX string "${text}"`);
  }
  if (ts.isJsxAttribute(node) && TEXT_ATTRIBUTES.has(node.name.getText())) {
    const value = ts.isJsxExpression(node.initializer ?? node)
      ? node.initializer.expression
      : node.initializer;
    for (const text of literalStrings(value))
      if (HAS_TEXT.test(text)) found.push(`${node.name.getText()}="${text}"`);
  }
  return found;
}

function scanFile(file, usage) {
  const where = relative(ui, file);
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const ast = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    kind,
  );
  const locate = (node) =>
    `${where}:${ast.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "t"
    )
      checkTranslateCall(node, usage, locate(node));
    if (kind === ts.ScriptKind.TSX)
      for (const problem of jsxLiteralProblems(node))
        fail(locate(node), `${problem} must go through t()`);
    ts.forEachChild(node, visit);
  };
  visit(ast);
}

function scanSource(usage) {
  const files = listFiles(srcDir).filter(
    (file) => /\.tsx?$/.test(file) && !TEST_FILE.test(file) && !file.startsWith(i18nDir + "/"),
  );
  for (const file of files) scanFile(file, usage);
  return files.length;
}

function checkUsage(catalogs, usage) {
  const known = new Set(catalogs.flatMap((catalog) => catalog.keys));
  const used = new Set();
  for (const { key, where } of usage.literals) {
    if (known.has(key)) used.add(key);
    else fail(where, `t("${key}") is not in any catalog`);
  }
  const dynamic = new Set(catalogs.flatMap((catalog) => catalog.dynamic));
  for (const { prefix, where } of usage.computed) {
    if (prefix === "")
      fail(where, "computed t() key has no literal prefix; use a literal or t(`area.part.${x}`)");
    else if (![...dynamic].some((key) => key.startsWith(prefix)))
      fail(where, `computed t("${prefix}...") has no dynamicKeys entry`);
  }
  for (const key of dynamic) {
    if (usage.computed.some(({ prefix }) => prefix !== "" && key.startsWith(prefix))) used.add(key);
    else fail("dynamicKeys", `${key} is listed but no computed t() call covers it`);
  }
  for (const catalog of catalogs)
    for (const key of catalog.keys)
      if (!used.has(key)) fail(relative(ui, catalog.file), `${key} is never used`);
}

if (!existsSync(srcDir)) {
  console.error("check-i18n: cannot run: src/ not found");
  process.exit(2);
}
const catalogs = await loadCatalogs();
const usage = { literals: [], computed: [] };
const scanned = scanSource(usage);
checkUsage(catalogs, usage);
if (errors.length > 0) {
  console.error(errors.join("\n"));
  console.error(`check-i18n: ${errors.length} violations`);
  process.exit(1);
}
const keyCount = catalogs.reduce((sum, catalog) => sum + catalog.keys.length, 0);
console.log(`check-i18n ok: ${catalogs.length} areas, ${keyCount} keys, ${scanned} source files`);
