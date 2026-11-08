// i18n gate (REQUIREMENTS rows 10, 11). An area's English catalog is src/i18n/<area>.ts with
// `export default { en }`, and each translation is src/i18n/<locale>/<area>.ts with
// `export default { "<locale>": … }`; flat keys `<area>.<part>.<name>`, ICU messages.
// src/i18n/<locale>/index.ts merges that locale's areas into the one table the app loads.
// A catalog may also export `dynamicKeys`, the one allowlist of its keys that are looked up
// through a computed `t(...)` argument.
//
// Catalogs: every area in every locale, and in its index.ts; same keys; every message parses as ICU; argument names
//   match across locales; key shape and area prefix; zh-TW has no Simplified-only and zh-CN
//   no Traditional-only characters (opencc-js conversion must change nothing).
// Source: every t("key") literal exists; every key is used by a literal or by `dynamicKeys`;
//   a computed t(`prefix.${x}`) needs a literal prefix that some `dynamicKeys` entry extends,
//   and every `dynamicKeys` entry must be covered by such a call; no JSX text literal and no
//   literal in a text prop (aria-label, title, placeholder, alt, Astryx label, description and
//   the rest of TEXT_ATTRIBUTES) in .tsx.
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
// Props that put text on screen or in the accessibility tree: the DOM ones, and the Astryx 0.7.11
// ones (its .d.ts props typed string or ReactNode that carry words, by name or by suffix).
const TEXT_ATTRIBUTES = new Set([
  "alt",
  "aria-braillelabel",
  "aria-brailleroledescription",
  "aria-description",
  "aria-label",
  "aria-placeholder",
  "aria-roledescription",
  "aria-valuetext",
  "body",
  "caption",
  "description",
  "formatHint",
  "heading",
  "label",
  "message",
  "placeholder",
  "subheading",
  "subtitle",
  "superheading",
  "text",
  "title",
  "tooltip",
  "unit",
  "units",
]);
// labelTooltip, dismissLabel, emptySearchText, disabledMessage, calendarDescription, imageAlt ...
const TEXT_ATTRIBUTE_SUFFIX =
  /[a-z](Label|Text|Message|Placeholder|Description|Tooltip|Alt|Heading|Title|Summary)$/;
const isTextAttribute = (name) => TEXT_ATTRIBUTES.has(name) || TEXT_ATTRIBUTE_SUFFIX.test(name);
const HAS_TEXT = /[\p{L}\p{N}]/u;
const TEST_FILE = /\.test(?:Support)?\.tsx?$/;
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

// `files` maps each locale to the file its messages came from.
function checkLocales(files, area, catalog) {
  const where = relative(ui, files.en);
  const reference = new Set(Object.keys(catalog.en));
  for (const locale of LOCALES) {
    const own = relative(ui, files[locale]);
    const keys = new Set(Object.keys(catalog[locale]));
    for (const key of reference) if (!keys.has(key)) fail(own, `${locale} lacks ${key}`);
    for (const key of keys) if (!reference.has(key)) fail(own, `${locale} has extra ${key}`);
  }
  for (const key of reference) {
    const shape = KEY_SHAPE.exec(key);
    if (!shape) fail(where, `${key}: key must be <area>.<part>.<name> in camelCase`);
    else if (shape[1] !== area) fail(where, `${key}: key must start with the area "${area}"`);
  }
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

async function load(file) {
  try {
    return await import(pathToFileURL(file).href);
  } catch (error) {
    console.error(
      `check-i18n: cannot run: ${file}: ${error instanceof Error ? error.message : error}`,
    );
    process.exit(2);
  }
}

const areaFiles = (dir) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith(".ts") && !TEST_FILE.test(name) && name !== "index.ts")
        .sort()
    : [];

// One locale's messages from a file whose default export must hold exactly that locale.
async function localeMessages(file, locale) {
  const exported = (await load(file)).default ?? {};
  const present = Object.keys(exported);
  if (present.length !== 1 || present[0] !== locale) {
    fail(relative(ui, file), `default export must have exactly the locale ${locale}`);
    return undefined;
  }
  return exported[locale];
}

const TRANSLATED = LOCALES.filter((locale) => locale !== "en");

// One area: src/i18n/<area>.ts and its translations, checked against each other.
async function loadArea(name) {
  const files = { en: join(i18nDir, name) };
  for (const locale of TRANSLATED) files[locale] = join(i18nDir, locale, name);
  const catalog = {};
  for (const locale of LOCALES) {
    if (!existsSync(files[locale])) fail(relative(ui, files[locale]), "is missing");
    else catalog[locale] = await localeMessages(files[locale], locale);
  }
  if (LOCALES.some((locale) => catalog[locale] === undefined)) return undefined;
  const area = basename(name, ".ts");
  checkLocales(files, area, catalog);
  checkMessages(files.en, catalog);
  const dynamic = (await load(files.en)).dynamicKeys ?? [];
  for (const key of dynamic)
    if (!(key in catalog.en)) fail(relative(ui, files.en), `dynamicKeys lists unknown key ${key}`);
  return { area, file: files.en, keys: Object.keys(catalog.en), dynamic, catalog };
}

// The app loads a translation through its index.ts; an area left out of it would show English.
async function checkIndexes(catalogs) {
  for (const locale of TRANSLATED) {
    const file = join(i18nDir, locale, "index.ts");
    if (!existsSync(file)) {
      fail(relative(ui, file), "is missing");
      continue;
    }
    const merged = new Set(Object.keys((await load(file)).default ?? {}));
    for (const { catalog } of catalogs)
      for (const key of Object.keys(catalog[locale]))
        if (!merged.has(key)) fail(relative(ui, file), `does not include ${key}`);
  }
}

async function loadCatalogs() {
  if (!existsSync(i18nDir)) return [];
  const names = areaFiles(i18nDir);
  for (const locale of TRANSLATED)
    for (const name of areaFiles(join(i18nDir, locale)))
      if (!names.includes(name))
        fail(relative(ui, join(i18nDir, locale, name)), `has no English src/i18n/${name}`);
  const catalogs = [];
  for (const name of names) {
    const loaded = await loadArea(name);
    if (loaded) catalogs.push(loaded);
  }
  await checkIndexes(catalogs);
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
  if (ts.isJsxAttribute(node) && isTextAttribute(node.name.getText())) {
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
