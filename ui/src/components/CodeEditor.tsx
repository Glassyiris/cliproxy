// The one code editor (CodeMirror 6) and the Rosé Pine syntax colours every code surface shares.
// CodeMirror is imported when the first editor mounts, so it stays out of the first load and out
// of every route chunk; until then the editor's box is a skeleton of the same size.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { EditorView } from "@codemirror/view";
import { Field } from "@astryxdesign/core/Field";
import { VStack } from "@astryxdesign/core/Layout";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { defineSyntaxTheme, SyntaxTheme } from "@astryxdesign/core/theme/syntax";
import { usePreferences } from "../app/preferences.ts";
import { layout } from "../themes/site/layout.ts";
import { dawn, main, moon, type RosePineVariant } from "../themes/site/rosePine.ts";

export type CodeLanguage = "yaml" | "json";

// Rosé Pine's own syntax roles (rose-pine/neovim `groups` and highlights): keywords pine, strings
// and numbers gold, booleans and functions rose, types, keys and tags foam, attributes iris,
// punctuation and operators subtle, comments muted. Light is Dawn; dark is the chosen palette.
const syntaxTheme = (dark: RosePineVariant, name: string) => {
  const pair = (role: keyof RosePineVariant): [string, string] => [dawn[role], dark[role]];
  return defineSyntaxTheme({
    name,
    tokens: {
      keyword: pair("pine"),
      string: pair("gold"),
      comment: pair("muted"),
      number: pair("gold"),
      function: pair("rose"),
      type: pair("foam"),
      variable: pair("text"),
      operator: pair("subtle"),
      constant: pair("rose"),
      tag: pair("foam"),
      attribute: pair("iris"),
      property: pair("foam"),
      punctuation: pair("subtle"),
      background: pair("surface"),
    },
  });
};

const themes = {
  moon: syntaxTheme(moon, "rose-pine-moon"),
  main: syntaxTheme(main, "rose-pine-main"),
};

/** Code shown or edited inside takes the Rosé Pine syntax colours of the chosen palette. */
export function CodeColors({ children }: { children: ReactNode }) {
  const { palette } = usePreferences();
  return <SyntaxTheme theme={themes[palette]}>{children}</SyntaxTheme>;
}

const loadCodeMirror = () =>
  Promise.all([
    import("@codemirror/state"),
    import("@codemirror/view"),
    import("@codemirror/language"),
    import("@codemirror/commands"),
    import("@lezer/highlight"),
    import("@codemirror/lang-yaml"),
    import("@codemirror/lang-json"),
  ]);

type Modules = Awaited<ReturnType<typeof loadCodeMirror>>;

const color = (token: string) => ({ color: `var(--color-syntax-${token})` });

function extensions(
  m: Modules,
  language: CodeLanguage,
  ids: { input: string; label: string },
  onChange: Change,
) {
  const [, view, lang, commands, { tags }, yaml, json] = m;
  const highlight = lang.HighlightStyle.define([
    { tag: [tags.comment, tags.lineComment, tags.blockComment], ...color("comment") },
    { tag: tags.keyword, ...color("keyword") },
    { tag: [tags.string, tags.special(tags.string)], ...color("string") },
    { tag: tags.number, ...color("number") },
    { tag: [tags.bool, tags.null, tags.atom], ...color("constant") },
    { tag: [tags.propertyName, tags.definition(tags.propertyName)], ...color("property") },
    { tag: tags.typeName, ...color("type") },
    { tag: [tags.labelName, tags.meta], ...color("attribute") },
    { tag: tags.variableName, ...color("variable") },
    { tag: tags.operator, ...color("operator") },
    { tag: [tags.punctuation, tags.separator, tags.bracket], ...color("punctuation") },
  ]);
  return [
    view.lineNumbers(),
    commands.history(),
    view.drawSelection(),
    lang.indentOnInput(),
    lang.bracketMatching(),
    lang.indentUnit.of("  "),
    lang.syntaxHighlighting(highlight),
    view.keymap.of([...commands.defaultKeymap, ...commands.historyKeymap]),
    language === "yaml" ? yaml.yaml() : json.json(),
    view.EditorView.contentAttributes.of({
      id: ids.input,
      "aria-labelledby": ids.label,
      spellcheck: "false",
    }),
    view.EditorView.updateListener.of((update) => {
      if (update.docChanged) onChange(update.state.doc.toString());
    }),
    view.EditorView.theme({
      "&": {
        height: `${layout.editorRows}lh`,
        color: "var(--color-text-primary)",
        backgroundColor: "var(--color-syntax-background)",
        border: "var(--border-width) solid var(--color-border-emphasized)",
        borderRadius: "var(--radius-element)",
        fontSize: "var(--text-code-size)",
      },
      "&.cm-focused": {
        outline: "var(--focus-outline-width) var(--focus-outline-style) var(--focus-outline-color)",
        outlineOffset: "var(--focus-outline-offset)",
      },
      ".cm-scroller": {
        fontFamily: "var(--font-family-code)",
        lineHeight: "var(--text-code-leading)",
        borderRadius: "var(--radius-element)",
      },
      ".cm-content": { caretColor: "var(--color-text-primary)", paddingBlock: "var(--spacing-2)" },
      ".cm-cursor": { borderInlineStartColor: "var(--color-text-primary)" },
      ".cm-gutters": {
        backgroundColor: "var(--color-syntax-background)",
        color: "var(--color-text-secondary)",
        border: "none",
      },
      // Rosé Pine selects with highlight med, which the theme's border token carries.
      "& .cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
        backgroundColor: "var(--color-border)",
      },
    }),
  ];
}

type Change = (text: string) => void;

/**
 * A YAML or JSON editor of `value`, labelled like any field. The text it reports is what the
 * operator typed; a new `value` from outside replaces the document.
 */
export function CodeEditor({
  label,
  language,
  value,
  onChange,
  status,
}: {
  label: string;
  language: CodeLanguage;
  value: string;
  onChange: Change;
  status?: { type: "error"; message: string };
}) {
  const inputId = useId();
  const labelId = useId();
  const host = useRef<HTMLElement>(null);
  const editor = useRef<EditorView | null>(null);
  const changed = useRef(onChange);
  useEffect(() => {
    changed.current = onChange;
  });
  const [isReady, setReady] = useState(false);
  const initial = useRef(value);

  useEffect(() => {
    let alive = true;
    void loadCodeMirror().then((modules) => {
      if (!alive || !host.current) return;
      const [state, view] = modules;
      editor.current = new view.EditorView({
        parent: host.current,
        state: state.EditorState.create({
          doc: initial.current,
          extensions: extensions(modules, language, { input: inputId, label: labelId }, (text) =>
            changed.current(text),
          ),
        }),
      });
      setReady(true);
    });
    return () => {
      alive = false;
      editor.current?.destroy();
      editor.current = null;
    };
  }, [language, inputId, labelId]);

  useEffect(() => {
    const view = editor.current;
    if (!view || view.state.doc.toString() === value) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value, isReady]);

  return (
    <Field
      label={label}
      inputID={inputId}
      labelID={labelId}
      status={status}
      statusVariant="detached"
    >
      <CodeColors>
        {!isReady && <Skeleton width="100%" height={`${layout.editorRows}lh`} />}
        {/* Empty until CodeMirror mounts into it, so the skeleton holds the height alone. */}
        <VStack ref={host} />
      </CodeColors>
    </Field>
  );
}
