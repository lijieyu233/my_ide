// scripts/cm6-entry.js —— CM6 打包入口（esbuild → renderer/vendor/cm6-bundle.min.js，全局 CM6）
import * as state from '@codemirror/state';
import * as view from '@codemirror/view';
import * as language from '@codemirror/language';
import * as commands from '@codemirror/commands';
import * as langMarkdown from '@codemirror/lang-markdown';
import * as search from '@codemirror/search';
import * as autocomplete from '@codemirror/autocomplete';

export const State = state;      // EditorState / Compartment / EditorSelection
export const View = view;        // EditorView / Decoration / ViewPlugin / WidgetType / keymap
export const Language = language; // syntaxHighlighting / defaultHighlightStyle / bracketMatching
export const Commands = commands; // history / defaultKeymap / indentWithTab
export const Md = langMarkdown;  // markdown / markdownLanguage
export const Search = search;    // searchKeymap / highlightSelectionMatches
export const Autocomplete = autocomplete; // autocompletion / closeBrackets
