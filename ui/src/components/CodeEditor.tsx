// The one code editor (CodeMirror 6) and the Rosé Pine syntax colours every code surface shares.
// CodeMirror is imported when the first editor mounts, so it stays out of the first load and out
// of every route chunk; until then the editor's box is a skeleton of the same size. The box has
// layout.codeEditor's fixed height and scrolls inside.
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
type Compartment = InstanceType<Modules[0]["Compartment"]>;

const { height } = layout.codeEditor;
// The content's block padding, as CodeMirror draws it below.
const padding = "var(--spacing-2)";

/**
 * Focus uses a ring over the box's edge because the dialog's scroll edge clips offset outlines.
 * An inset shadow or outline falls under the gutter's background and breaks the ring's left edge.
 */
const focusRing = {
  "&.cm-focused": { outline: "none" },
  "&.cm-focused::after": {
    content: '""',
    position: "absolute",
    inset: "calc(-1 * var(--border-width))",
    border: "var(--focus-outline-width) var(--focus-outline-style) var(--focus-outline-color)",
    borderRadius: "var(--radius-element)",
    pointerEvents: "none",
    zIndex: 500,
  },
};

const color = (token: string) => ({ color: `var(--color-syntax-${token})` });

function extensions(
  m: Modules,
  language: CodeLanguage,
  ids: { input: string; label: string },
  onChange: Change,
  described: Compartment,
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
    // The error under the box, while there is one (reconfigured by the component).
    described.of(view.EditorView.contentAttributes.of({})),
    view.EditorView.updateListener.of((update) => {
      if (update.docChanged) onChange(update.state.doc.toString());
    }),
    view.EditorView.theme({
      "&": {
        height,
        color: "var(--color-text-primary)",
        backgroundColor: "var(--color-syntax-background)",
        border: "var(--border-width) solid var(--color-border-emphasized)",
        borderRadius: "var(--radius-element)",
        fontSize: "var(--text-code-size)",
      },
      ...focusRing,
      ".cm-scroller": {
        fontFamily: "var(--font-family-code)",
        lineHeight: "var(--text-code-leading)",
        borderRadius: "var(--radius-element)",
        overflow: "auto",
      },
      ".cm-content": { caretColor: "var(--color-text-primary)", paddingBlock: padding },
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
 * CodeMirror mounted into `host` once its modules load, holding `value`; `describedBy` is the id
 * of the error that describes the content, or null while there is none.
 */
function useCodeMirror(
  language: CodeLanguage,
  value: string,
  onChange: Change,
  ids: { input: string; label: string },
  describedBy: string | null,
) {
  const host = useRef<HTMLElement>(null);
  const editor = useRef<EditorView | null>(null);
  const describe = useRef<((id: string | null) => void) | null>(null);
  const changed = useRef(onChange);
  useEffect(() => {
    changed.current = onChange;
  });
  const [isReady, setReady] = useState(false);
  const initial = useRef(value);
  const { input, label } = ids;

  useEffect(() => {
    let alive = true;
    void loadCodeMirror().then((modules) => {
      if (!alive || !host.current) return;
      const [state, view] = modules;
      const described = new state.Compartment();
      const onEdit = (text: string) => changed.current(text);
      const created = new view.EditorView({
        parent: host.current,
        state: state.EditorState.create({
          doc: initial.current,
          extensions: extensions(modules, language, { input, label }, onEdit, described),
        }),
      });
      editor.current = created;
      describe.current = (id) =>
        created.dispatch({
          effects: described.reconfigure(
            view.EditorView.contentAttributes.of(
              id ? { "aria-describedby": id, "aria-invalid": "true" } : {},
            ),
          ),
        });
      setReady(true);
    });
    return () => {
      alive = false;
      editor.current?.destroy();
      editor.current = null;
      describe.current = null;
    };
  }, [language, input, label]);

  useEffect(() => describe.current?.(describedBy), [describedBy, isReady]);

  useEffect(() => {
    const view = editor.current;
    if (!view || view.state.doc.toString() === value) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value, isReady]);

  return { host, isReady };
}

/**
 * A YAML or JSON editor of `value`, labelled like any field (`isLabelHidden` keeps the label for
 * assistive technology only). The text it reports is what the operator typed; a new `value` from
 * outside replaces the document. An error `status` shows under the box and describes it.
 */
export function CodeEditor({
  label,
  language,
  value,
  onChange,
  status,
  isLabelHidden = false,
}: {
  label: string;
  language: CodeLanguage;
  value: string;
  onChange: Change;
  status?: { type: "error"; message: string };
  isLabelHidden?: boolean;
}) {
  const inputId = useId();
  const labelId = useId();
  const statusId = useId();
  const { host, isReady } = useCodeMirror(
    language,
    value,
    onChange,
    { input: inputId, label: labelId },
    status?.message ? statusId : null,
  );

  return (
    <Field
      label={label}
      inputID={inputId}
      labelID={labelId}
      isLabelHidden={isLabelHidden}
      status={status && { ...status, messageID: statusId }}
      statusVariant="detached"
    >
      <CodeColors>
        {!isReady && <Skeleton width="100%" height={height} />}
        {/* Empty until CodeMirror mounts into it, so the skeleton holds the height alone. */}
        <VStack ref={host} />
      </CodeColors>
    </Field>
  );
}
