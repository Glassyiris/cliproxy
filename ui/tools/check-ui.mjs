// Token, layout and motion bans for src/ (REQUIREMENTS rows 3, 4, 5, 11, 20).
//
// - Colour, px and radius/spacing literals and `style` attributes: only under src/themes/.
// - Size literals (a number or a length such as "8rem") on the size props of the Astryx 0.7.11
//   components in use, as JSX attributes or object properties: only under src/themes/. Spacing
//   scale props (gap, padding) take scale steps and stay legal; "100%" and full-viewport lengths
//   fill their container and are not sizes.
// - CSS files and CSS imports: only src/themes/ and the entry src/main.tsx (imports only). Under
//   src/themes/, CSS other than the generated site.css and site-main.css selects only html, body
//   and :root (with attribute selectors) and has no transition, animation or @keyframes.
// - transition/animation/keyframes and animation libraries: only under src/components/motion/.
// - Raw <div> and <span>: Astryx has Stack, HStack, Grid, Center, Layout and Text (0.7.11).
// - Raw <svg> and <path>: icons are Astryx's semantic names or lucide components passed to Icon,
//   the brand mark included.
// - registerIcons: no app icon registry; the theme's registry is the only one (Astryx default).
// - A `components` block in a theme source under src/themes/: the theme sets tokens only, and
//   component styles come from Astryx and the neutral theme it extends.
// - No module or directory named util, common, helper, shared or misc.
// - Type roles (src/themes/site/roles.ts): Heading levels 1 to 4; Text and Heading `size`,
//   `weight` and `type` only as the roles table allows, written as literals or `roles.*`; it names
//   no Heading `type`, since the level sets the scale. A route file (the page a feature's index.ts
//   exports) has at most one level-1 Heading and renders PageFrame, whose LayoutHeader holds the
//   page's h1, so the h1 sits at one place on every page.
// - Card padding: a Card or ClickableCard takes roles.card.padding (the nbcards admin's one card
//   padding) or 0 (a flush card around a list); the exceptions below say why.
//
// Tests and the i18n catalogs are skipped: tests hold fixtures and the catalogs hold prose.
// Exit codes: 0 clean, 1 violation, 2 cannot read src/.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { roles } from "../src/themes/site/roles.ts";

// An optional argument points the gate at another ui/ directory (used to drive it red).
const ui = resolve(process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url)));
const srcDir = join(ui, "src");
const ENTRY = "src/main.tsx";
const THEMES = "src/themes/";
const MOTION = "src/components/motion/";

const RAW_COLOR =
  /#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{3,4})\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\s*\(|(?:^|[\s,(])(?:white|black)(?=$|[\s,)])/i;
const RAW_PX = /\b\d+(?:\.\d+)?px\b/;
const CSS_MODULE = /\.(?:css|scss|sass|less|styl)(?:\?.*)?$/;
const MOTION_PROPERTY = /^(?:transition|animation)(?:$|-|[A-Z])/;
const MOTION_TEXT = /@keyframes|(?:^|[;{\s])(?:transition|animation)(?:-[a-z-]+)?\s*:/;
const MOTION_LIBRARY =
  /^(?:framer-motion|motion(?:\/.*)?|@react-spring\/.*|react-spring|react-transition-group|gsap|animejs)$/;
const SPACING_PROPERTY = /^(?:padding.*|margin.*|gap|rowGap|columnGap|borderRadius|fontSize)$/;
const ZERO_OR_KEYWORD = new Set(["0", "auto", "inherit", "initial", "unset"]);
// Width and height props of Card, Center, Layout, LayoutPanel, LayoutHeader, LayoutFooter,
// Skeleton, Button, TextInput, MetadataList, DropdownMenu, the stacks and SideNav `resizable`.
const SIZE_PROPERTY = new Set([
  "width",
  "height",
  "minWidth",
  "maxWidth",
  "minHeight",
  "maxHeight",
  "contentWidth",
  "defaultWidth",
  "menuWidth",
  "menuMaxHeight",
]);
// A length anywhere in the value, so `min(60rem, 100%)` is caught as well as `60rem`.
const LENGTH = /(?:^|[^\w.])-?(?:\d+\.?\d*|\.\d+)(?:[a-z]+|%)?(?![\w.])/i;
const FILL_ANYWHERE = /\b100(?:%|[dls]?v[hw]|v(?:min|max|[bi]))(?![\w.])|\b0(?![\w.%])/g;
// What `astryx theme build` writes; every other CSS file under src/themes/ is hand-written.
const GENERATED_CSS = new Set(["src/themes/site/site.css", "src/themes/site/site-main.css"]);
const PAGE_SELECTOR = /^(?:html|body|:root)(?:\[[^\]]+\])*$/;
const BANNED_NAME = /^(?:utils?|common|helpers?|shared|misc)$/i;
const TEST_FILE = /\.test(?:-support)?\.tsx?$/;
const HEADING_LEVELS = new Set(Object.values(roles.heading));
const TYPE_PROPS = {
  Text: {
    size: new Set(Object.values(roles.textSize)),
    weight: new Set(Object.values(roles.textWeight)),
    type: new Set(Object.values(roles.textType)),
  },
  Heading: { size: new Set(), weight: new Set(), type: new Set() },
};
const FRAME = "src/app/PageFrame.tsx";
const CARD_PADDINGS = new Set([roles.card.padding, 0]);
const CARD_PADDING_EXCEPTIONS = {
  // login-card's own card (padding 8); card-v2 UI-RULES.md exempts the auth card the same way.
  "src/app/SignIn.tsx": "sign-in card",
  // A chart tooltip is a popover drawn as a small card, as card-v2's TrendTip draws it.
  "src/components/charts/plots.tsx": "chart tooltip",
  // Pages R1 to R5 rewrite next; each leaves this list when it is rewritten.
  "src/features/connect/SignInPanel.tsx": "not yet rewritten",
};
const DEFAULT_EXPORT = /export\s*\{\s*default\s*\}\s*from\s*["'](\.\/[^"']+)["']/;

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? listFiles(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

function literalValue(node) {
  if (!node) return undefined;
  if (ts.isJsxExpression(node)) return literalValue(node.expression);
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  return undefined;
}

function propertyName(node) {
  return node.name.getText().replaceAll(/["']/g, "");
}

function textOf(node) {
  if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node)) return node.text;
  if (ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) return node.text;
  return undefined;
}

function checkMotion(node, fail) {
  if (ts.isPropertyAssignment(node) && MOTION_PROPERTY.test(propertyName(node)))
    fail("motion", node, "transition and animation live in src/components/motion/");
  if (ts.isCallExpression(node) && /(?:^|\.)keyframes$/.test(node.expression.getText()))
    fail("motion", node, "keyframes live in src/components/motion/");
  const text = textOf(node);
  if (text !== undefined && MOTION_TEXT.test(text))
    fail("motion", node, "transition, animation and @keyframes live in src/components/motion/");
}

function moduleSpecifier(node) {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier)
    return node.moduleSpecifier;
  const dynamic = ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword;
  return dynamic ? node.arguments[0] : undefined;
}

function checkImport(node, fail, { relativePath, inMotion }) {
  const specifier = moduleSpecifier(node);
  if (!specifier || !ts.isStringLiteralLike(specifier)) return;
  if (CSS_MODULE.test(specifier.text) && relativePath !== ENTRY && !relativePath.startsWith(THEMES))
    fail("css", node, `CSS is imported only by ${ENTRY} and src/themes/`);
  if (!inMotion && MOTION_LIBRARY.test(specifier.text))
    fail("motion", node, "animation libraries are used only in src/components/motion/");
}

function checkTokens(node, fail) {
  const text = textOf(node);
  if (text !== undefined) {
    if (RAW_COLOR.test(text)) fail("colors", node, "colours come from src/themes/ tokens");
    if (RAW_PX.test(text)) fail("px", node, "px values come from src/themes/ tokens");
  }
  if (ts.isPropertyAssignment(node) && SPACING_PROPERTY.test(propertyName(node))) {
    const value = literalValue(node.initializer);
    if (typeof value === "number" && value !== 0)
      fail("tokens", node, "spacing, radius and font size use theme tokens, not numbers");
    if (typeof value === "string" && !ZERO_OR_KEYWORD.has(value) && !value.includes("var(--"))
      fail("tokens", node, "spacing, radius and font size use theme tokens, not literals");
  }
}

function checkSize(node, fail) {
  const named = ts.isJsxAttribute(node) || ts.isPropertyAssignment(node);
  if (!named || !SIZE_PROPERTY.has(propertyName(node))) return;
  const value = literalValue(node.initializer);
  const size =
    typeof value === "number"
      ? value !== 0
      : typeof value === "string" && LENGTH.test(value.replace(FILL_ANYWHERE, ""));
  if (size && value !== "0")
    fail("size", node, "sizes come from src/themes/ (layout.ts), not literals");
}

function checkJsx(node, fail) {
  if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
    const name = node.tagName.getText();
    if (name === "div" || name === "span")
      fail("layout", node, `<${name}> is banned; use Stack, HStack, Grid, Center, Layout or Text`);
  }
  if (ts.isJsxAttribute(node) && node.name.getText() === "style")
    fail("style", node, "no style attribute; use StyleX with theme tokens");
}

function checkGlyph(node, fail) {
  if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return;
  const name = node.tagName.getText();
  if (name === "svg" || name === "path")
    fail("icons", node, `<${name}>: use a semantic name or a lucide component`);
}

function checkRegistry(node, fail) {
  if (ts.isIdentifier(node) && node.text === "registerIcons")
    fail(
      "icons",
      node,
      "registerIcons is banned; use the theme's semantic names or lucide components",
    );
}

function checkThemeSource(node, fail) {
  const named = ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node);
  if (named && propertyName(node) === "components")
    fail("theme", node, "the theme sets tokens only; no component style block");
}

function checkNames(relativePath, fail) {
  const segments = relativePath.split("/").slice(1);
  const names = segments.map((segment, index) =>
    index === segments.length - 1 ? segment.replace(/\..*$/, "") : segment,
  );
  const bad = names.find((name) => BANNED_NAME.test(name));
  if (bad) fail("naming", null, `"${bad}" is a banned module or directory name`);
}

// Hand-written theme CSS styles the page behind the app and nothing else: component looks come
// from Astryx and the theme tokens, and motion comes from the shared motion module.
function checkHandCss(text, fail) {
  const css = text.replace(/\/\*[\s\S]*?\*\//g, "");
  if (MOTION_TEXT.test(css))
    fail("css", null, "no transition, animation or @keyframes in theme CSS");
  for (const [, prelude] of css.matchAll(/(?:^|[;{}])([^;{}]*)\{/g)) {
    const head = prelude.trim();
    if (head.startsWith("@")) continue;
    for (const selector of head.split(",").map((part) => part.trim()))
      if (!PAGE_SELECTOR.test(selector))
        fail("css", null, `theme CSS may select only html, body and :root, not "${selector}"`);
  }
}

// The values an attribute can take: literals, both branches of a conditional, or a `roles.*`
// path. Undefined when any part is something else, which the table cannot vouch for.
function choicesOf(node) {
  if (!node) return undefined;
  if (ts.isJsxExpression(node) || ts.isParenthesizedExpression(node))
    return choicesOf(node.expression);
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isNumericLiteral(node)) return [Number(node.text)];
  if (ts.isConditionalExpression(node)) {
    const [yes, no] = [choicesOf(node.whenTrue), choicesOf(node.whenFalse)];
    return yes && no ? [...yes, ...no] : undefined;
  }
  if (ts.isPropertyAccessExpression(node) && /^roles\./.test(node.getText())) {
    const value = node
      .getText()
      .split(".")
      .slice(1)
      .reduce((object, key) => object?.[key], roles);
    return typeof value === "string" || typeof value === "number" ? [value] : undefined;
  }
  return undefined;
}

function attributeOf(element, name) {
  return element.attributes.properties.find(
    (property) => ts.isJsxAttribute(property) && property.name.getText() === name,
  );
}

function isPageTitle(node) {
  if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return false;
  if (node.tagName.getText() !== "Heading") return false;
  const level = choicesOf(attributeOf(node, "level")?.initializer);
  return level?.length === 1 && level[0] === roles.heading.page;
}

function checkTypeRoles(node, fail) {
  if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return;
  const tag = node.tagName.getText();
  if (tag === "Heading") {
    const levels = choicesOf(attributeOf(node, "level")?.initializer);
    if (!levels || levels.some((level) => !HEADING_LEVELS.has(level)))
      fail("type", node, "Heading level is 1 to 4, a literal or roles.heading.*");
  }
  for (const [prop, allowed] of Object.entries(TYPE_PROPS[tag] ?? {})) {
    const attribute = attributeOf(node, prop);
    if (!attribute) continue;
    const values = choicesOf(attribute.initializer);
    if (!values || values.some((value) => !allowed.has(value)))
      fail("type", node, `${tag} ${prop} is not in the roles table (src/themes/site/roles.ts)`);
  }
}

function checkCardPadding(node, fail, relativePath) {
  if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return;
  if (!["Card", "ClickableCard"].includes(node.tagName.getText())) return;
  if (relativePath in CARD_PADDING_EXCEPTIONS) return;
  const attribute = attributeOf(node, "padding");
  const values = attribute ? choicesOf(attribute.initializer) : [undefined];
  if (!values || values.some((value) => !CARD_PADDINGS.has(value)))
    fail("card", node, "a Card takes padding={roles.card.padding} or 0");
}

function rendersFrame(node) {
  if (
    (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
    node.tagName.getText() === "PageFrame"
  )
    return true;
  return ts.forEachChild(node, rendersFrame) ?? false;
}

function headerHoldsTitle(node) {
  if (ts.isJsxElement(node) && node.openingElement.tagName.getText() === "LayoutHeader") {
    let found = false;
    const search = (child) => {
      found ||= isPageTitle(child);
      if (!found) ts.forEachChild(child, search);
    };
    search(node);
    if (found) return true;
  }
  return ts.forEachChild(node, headerHoldsTitle) ?? false;
}

function checkRouteFile(ast, fail) {
  const titles = [];
  const collect = (node) => {
    if (isPageTitle(node)) titles.push(node);
    ts.forEachChild(node, collect);
  };
  collect(ast);
  if (titles.length > 1) fail("type", titles[1], "a route has one level-1 Heading");
  if (!rendersFrame(ast)) fail("type", null, "a route renders PageFrame");
}

// The page each feature's index.ts exports as its default: the file a route renders.
function routeFiles() {
  const features = join(srcDir, "features");
  if (!existsSync(features)) return new Set();
  return new Set(
    readdirSync(features).flatMap((name) => {
      const index = join(features, name, "index.ts");
      const target = existsSync(index) && DEFAULT_EXPORT.exec(readFileSync(index, "utf8"))?.[1];
      return target ? [`src/features/${name}/${target.slice(2)}`] : [];
    }),
  );
}

function checkFile(file, errors, routes) {
  const relativePath = relative(ui, file).replaceAll("\\", "/");
  const inThemes = relativePath.startsWith(THEMES);
  const inMotion = relativePath.startsWith(MOTION);
  let ast;
  const fail = (rule, node, message) => {
    const line = node && ast ? ast.getLineAndCharacterOfPosition(node.getStart()).line + 1 : 1;
    errors.push(`${relativePath}:${line} [${rule}] ${message}`);
  };
  checkNames(relativePath, fail);
  if (file.endsWith(".css")) {
    if (!inThemes) fail("css", null, "CSS files live only in src/themes/");
    else if (!GENERATED_CSS.has(relativePath)) checkHandCss(readFileSync(file, "utf8"), fail);
    return;
  }
  if (TEST_FILE.test(file) || relativePath.startsWith("src/i18n/")) return;
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  ast = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, kind);
  const themeSource = inThemes && !file.endsWith(".d.ts") && /\.tsx?$/.test(file);
  const visit = (node) => {
    checkImport(node, fail, { relativePath, inMotion });
    checkGlyph(node, fail);
    checkRegistry(node, fail);
    checkTypeRoles(node, fail);
    checkCardPadding(node, fail, relativePath);
    if (themeSource) checkThemeSource(node, fail);
    if (!inMotion) checkMotion(node, fail);
    if (!inThemes) {
      checkJsx(node, fail);
      checkTokens(node, fail);
      checkSize(node, fail);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (routes.has(relativePath)) checkRouteFile(ast, fail);
  if (relativePath === FRAME && !headerHoldsTitle(ast))
    fail("type", null, "PageFrame draws a LayoutHeader holding the level-1 Heading");
}

if (!existsSync(srcDir)) {
  console.error("check-ui: cannot run: src/ not found");
  process.exit(2);
}
const errors = [];
const files = listFiles(srcDir).filter((file) => /\.(?:tsx?|css)$/.test(file));
const routes = routeFiles();
for (const file of files) checkFile(file, errors, routes);
if (errors.length > 0) {
  console.error(errors.join("\n"));
  console.error(`check-ui: ${errors.length} violations`);
  process.exit(1);
}
console.log(
  `check-ui ok: ${files.length} source files (colours, px, tokens, sizes, style, layout, css, motion, names, icons, theme, type roles, card padding)`,
);
