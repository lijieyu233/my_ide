// scripts/cm6-entry.js —— CM6 打包入口（esbuild → renderer/vendor/cm6-bundle.min.js，全局 CM6）
// 重建：npx esbuild scripts/cm6-entry.js --bundle --minify --format=iife --global-name=CM6 --outfile=renderer/vendor/cm6-bundle.min.js
import * as state from '@codemirror/state';
import * as view from '@codemirror/view';
import * as language from '@codemirror/language';
import * as commands from '@codemirror/commands';
import * as langMarkdown from '@codemirror/lang-markdown';
import * as search from '@codemirror/search';
import * as autocomplete from '@codemirror/autocomplete';
import { tags } from '@lezer/highlight';

import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { java } from '@codemirror/lang-java';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { json } from '@codemirror/lang-json';
import { cpp } from '@codemirror/lang-cpp';

export const State = state;      // EditorState / Compartment / EditorSelection
export const View = view;        // EditorView / Decoration / ViewPlugin / WidgetType / keymap
export const Language = language; // syntaxHighlighting / defaultHighlightStyle / bracketMatching
export const Commands = commands; // history / defaultKeymap / indentWithTab
export const Md = langMarkdown;  // markdown / markdownLanguage
export const Search = search;    // searchKeymap / highlightSelectionMatches
export const Autocomplete = autocomplete; // autocompletion / closeBrackets

// 语法高亮构建块（自定义配色用）
export const Highlight = { tags };

// 围栏代码块语言支持（```js / ```python / ...）：LanguageDescription + 懒加载
export const CodeLangs = { javascript, python, java, css, html, json, cpp };
