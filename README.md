# pi-apply-patch-plus

[English](README.md) | [简体中文](README.zh-CN.md)

Bring **Codex-style patch-based editing** to [pi](https://github.com/earendil-works/pi): describe multiple file changes — add, update, delete, move — in one structured `apply_patch` envelope, with local format verification and a colored diff preview. Smartly recognizes GPT-family models and automatically enables patch editing, taking over `edit` / `write` — no hardcoded model list to maintain.

## Features

- **Patch-based multi-file editing** — one patch envelope describes all changes at a glance:

  ```text
  *** Begin Patch
  *** Add File: src/new.ts
  +export const value = 1;

  *** Update File: src/app.ts
  @@
  -const oldValue = 0;
  +const newValue = 1;

  *** Delete File: src/obsolete.ts
  *** End Patch
  ```

- **Local verification first** — the patch is parsed and validated (envelope, operation headers, context matching, `+` prefixes) before anything touches the filesystem; invalid patches are rejected instead of silently producing wrong results.
- **Smart GPT detection** — any `gpt-*` model gets the tool automatically (`gpt-5.6-sol` / `gpt-5.6-luna` / `gpt-5.6-terra` / `gpt-4o`, and future GPT models); non-GPT models keep it hidden.
- **Codex remote constraint** — on `gpt-5.2/5.3-codex`, patches are sent to the OpenAI Codex API as CFG-constrained freeform tools, constrained at the grammar level.
- **Diff UI & live counters** — pi's native diff renderer shows colored diffs, with per-file `+X -Y` counts and progress.
- **Interrupted-turn recovery** — orphaned custom tool calls are auto-completed with synthetic cancellation output so follow-up prompts never fail on a missing `custom_tool_call_output`.
- **Tool takeover policy** — while active, `edit` / `write` are disabled in favor of `apply_patch`, preventing parallel tools from clobbering the same file; they are restored automatically on non-GPT models.

## Install

```bash
pi install git:github.com/matsuzaka-yuki/pi-apply-patch-plus
```

Or for local development:

```bash
pi install ./
```

## How it works

1. Registers an `apply_patch` tool in pi;
2. Enforces the per-model tool policy: GPT models get `apply_patch` and lose `edit` / `write`; non-GPT models get the built-in editing tools back;
3. On `gpt-5.2/5.3-codex`, the tool is sent to the Codex API as `type: "custom"` + `syntax: "lark"`, and `custom_tool_call` events are mapped back to pi tool calls;
4. Parses the patch locally → validates → applies file changes → replies with `custom_tool_call_output`;
5. Renders per-file `+X -Y` counters and a colored diff throughout (expand the tool output to see the full patch).

## Patch format

Envelope structure:

```text
*** Begin Patch
*** Add File: hello.txt
+Hello
*** End Patch
```

Supported operations:

- `*** Add File: <path>` — create a file (every line of content prefixed with `+`)
- `*** Delete File: <path>` — remove a file
- `*** Update File: <path>` (optional `*** Move to: <path>`) — patch in place / rename
- hunks starting with `@@`, lines prefixed with ` ` (context), `+` (added), `-` (removed)

Path behavior matches pi's `write` semantics: relative paths resolve against the current working directory.

## Model support

| Model | Behavior |
|-------|----------|
| Any `gpt-*` (e.g. `gpt-5.6-sol`, `gpt-5.6-luna`, `gpt-5.6-terra`) | Local support: regular JSON tool, patch in the `input` field |
| `gpt-5.2-codex*` / `gpt-5.3-codex*` | Full support: additionally sent as CFG/freeform tool over the Codex API |
| Non-GPT models (`claude-*`, `deepseek-*`, `glm-*`, …) | Tool hidden and blocked |

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
```

## Acknowledgments

This project's feature design and interaction ideas are inspired by the MIT-licensed [pi-extension-codex-apply-patch](https://www.npmjs.com/package/pi-extension-codex-apply-patch) project — thanks to the original author for the open-source contribution. On top of it, this project rewrote the model-detection logic (smart GPT recognition instead of a hardcoded list), documentation, and project packaging to better fit personal use.
