# MyIDE — AI-assisted Markdown and code workspace for Windows

MyIDE is a Windows desktop workspace for local documents and multiple projects. It combines a Markdown live-preview editor, code and JSON editing, Git tools, an embedded browser, and AI workbench actions. Built with Electron, vanilla JavaScript, and CodeMirror 6.

[简体中文](README.md) · [Getting started](docs/getting-started.md) · [Features and limitations](docs/features.md) · [AI tools](docs/ai-api.md) · [Documentation](docs/README.md) · [Report an issue](https://github.com/lijieyu233/my_ide/issues)

![MyIDE editing one Markdown document in two panes with independent tabs, toolbars, and scroll positions](docs/images/editor-split.png)

*A real application screenshot from an isolated demo project. Both panes show different positions in the same document.*

## What can I use it for?

| Task | Available functionality |
| --- | --- |
| Edit Markdown notes and documentation | Live preview, source and preview modes, source/preview comparison, heading outline, table editing, image copy and resizing |
| Work in two editor panes | Split right or down; show the same document in both panes, synchronize edits, and navigate or scroll independently |
| Inspect code and JSON | Syntax highlighting, find/replace, JSON structure outline and folding, encoding selection, project search |
| Manage local projects | Project-specific sessions, file tree, Git status/diff/history/commit/sync, application launch panel |
| Use AI within the workspace | Attach files or selections and use existing workbench tools for the editor, browser, Git, tasks, launch panel, and other modules |
| Browse and read | Embedded browser tabs, favorites, saved tab groups and selection translation; a bookshelf for TXT, basic reflowable EPUB, and CBZ |

See [features and limitations](docs/features.md) for scope. AI requires a configured model service; DSH has additional runtime requirements. Local editing is available without AI configuration.

## Run from source

The current source version is **0.8.5**. The **dev** branch is ongoing development, not a stable-release guarantee. Windows is the primary development and verification platform.

Install Git, Node.js 24, and npm:

~~~powershell
git clone --branch dev https://github.com/lijieyu233/my_ide.git
cd my_ide
npm ci
npm start
~~~

Open a local project directory after startup. Network access is required to install dependencies and download Electron. See [setup and troubleshooting](docs/getting-started.md).

[Releases](https://github.com/lijieyu233/my_ide/releases) is the place for published installers. There is currently no formal Latest Release; the source ZIP does not provide a ready-to-run EXE. Running npm run build creates a local Windows portable build in dist/.

## AI workbench tools

Example requests include splitting the current document, inspecting a JSON outline, reading a configured application's launch status or logs, and explaining Git changes. Results depend on the model, current state, configuration, and permissions.

The tools use state snapshots, project/session ownership, and permission checks. They are intended for the in-application assistant: **they are not currently a standalone public HTTP API or MCP server**. See the [AI tools guide](docs/ai-api.md) and the [module checklist](docs/开发文档-171-AI操作接口模块清单.md).

## Status and boundaries

- MyIDE is under active development. Passing a focused check does not imply a fully passing test suite; scope and failures are documented in development records.
- Some Git operations require system Git. The JavaScript fallback does not implement every native capability.
- Reader support covers TXT, basic reflowable EPUB, and CBZ, with no promise of PDF conversion, comic OCR, DRM support, or universal ebook compatibility.
- Files are primarily local. Configured AI, translation, or SSH operations may send relevant content to their services; this is not a claim that every feature runs offline.
- No open-source license is currently declared. Public availability alone does not grant unrestricted rights to use, modify, or redistribute the code.

## Documentation and development

- [Documentation index](docs/README.md): guides, interfaces, and implementation records.
- [Development and publishing](docs/development.md): checks, branch roles, release requirements, and screenshots.
- [Roadmap](ROADMAP.md), [progress tracker](docs/改进进度总览.md), and [plugin guide](plugins/README.md).

Issues should include OS, version/commit, reproduction steps, expected/actual behavior, and redacted screenshots where useful. Repository contributions follow [AGENTS.md](AGENTS.md).
