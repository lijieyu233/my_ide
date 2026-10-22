# MyIDE — An AI-powered local workspace

**Work with project documents, code, web pages, and development tools in one desktop workspace, with an AI assistant that can use the tools.**

MyIDE is an open-source Windows application for technical documentation, code projects, research, and day-to-day development tasks. Start from your local files, bring relevant context to AI, and inspect the actual edits and execution results in the same application.

[简体中文](README.md) · [Download and setup](docs/getting-started.md) · [Workflows](docs/workflows.md) · [Capabilities](docs/features.md) · [Documentation](docs/README.md)

![MyIDE project workspace with a file tree, document editor, and AI assistant](docs/images/workspace.png)

*A real application screenshot using an isolated project with fictional content. No AI execution results are fabricated.*

## Why MyIDE?

A single task often spans notes, source files, browser tabs, terminals, Git, and a database. Moving between applications also means repeatedly explaining the project to an assistant and copying its results back.

MyIDE brings these tools together around ordinary local files. You can inspect material, edit documents or code, run configured tools, and verify the result without rebuilding the context for every step. Other editors and Git can continue to use the same files.

## Core workflows

### 1. Work with AI in project context

Attach files or selections, inspect the current workspace, and ask the assistant to analyze code, organize documents, or investigate an issue. Use an OpenAI-compatible model service through the standard assistant, or connect a locally installed DeepSeek Harness (DSH).

In-application tools cover project files, the editor, outlines, the browser, Git, tasks, launch management, SSH/SFTP, databases, and settings. State checks and existing permissions govern actions; actual results must be checked afterward. Background DSH work remains attached to its original project and session.

[AI setup and workflow](docs/ai-guide.md) · [Tool interfaces and scope](docs/ai-api.md)

### 2. Keep documents and project knowledge together

Navigate multiple local projects, search and edit Markdown, code, and JSON, and preview HTML, images, PDF, and common Office files. Markdown live preview and outlines support writing; JSON structure navigation helps inspect data. Each project retains its working session.

The embedded browser supports research, saved tab groups, and selection translation. The bookshelf tracks TXT, basic EPUB, and CBZ reading. Split editing, table editing, and image controls are supporting editor features described in the [capability guide](docs/features.md).

### 3. Connect development work to real tools

Inspect Git status, history, and diffs, then commit or synchronize changes. Manage configured processes, readiness checks, ports, and logs through the launch panel. Use SSH/SFTP for remote terminals and files, database tools for queries, and tasks for tracking work.

These modules have direct UI controls as well as in-application AI tools. Remote connections, process execution, and data writes depend on your configuration and permissions.

[Workflow examples](docs/workflows.md) · [Capabilities and limitations](docs/features.md)

## Get started

Source setup requires Windows, Git, and Node.js 24:

~~~powershell
git clone --branch dev https://github.com/lijieyu233/my_ide.git
cd my_ide
npm ci
npm start
~~~

- [Download and first use](docs/getting-started.md): Windows portable builds, source setup, and configuration.
- [GitHub Releases](https://github.com/lijieyu233/my_ide/releases): use the actual assets and notes; preview releases are explicitly labeled.
- Local editing does not require AI. Configure model, translation, SSH, and database services when you need them.

## Project status

Built with Electron, JavaScript, and CodeMirror 6. Development happens on dev, with Windows as the primary verified platform. The focus is document and project workflows; a full IDE debugger, language services, and extension ecosystem are outside the current scope.

AI tools are for the in-application assistant. There is no published standalone HTTP API or MCP server. Configured remote services receive relevant content when used. See [release notes and known issues](CHANGELOG.md) for verification scope.

[Documentation](docs/README.md) · [Issues](https://github.com/lijieyu233/my_ide/issues) · [Contributing](CONTRIBUTING.md) · [Architecture](docs/architecture.md)

Project code is licensed under [MIT](LICENSE). Third-party dependencies and bundled resources retain their respective licenses.
