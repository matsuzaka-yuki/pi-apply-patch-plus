import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { renderDiff } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
	applyParsedPatch,
	parseApplyPatch,
	type ApplyPatchFileDiff,
	type ApplyPatchProgressFile,
} from "./apply-patch.js";
import { parseApplyPatchInputProgress } from "./apply-patch-progress.js";
import {
	streamSimpleCodexWithCustomApplyPatch,
	supportsApplyPatchModel,
} from "./codex-provider.js";

const applyPatchToolSchema = Type.Object({
	input: Type.String({
		description: "The full apply_patch payload in Codex patch format.",
	}),
});

const APPLY_PATCH_USAGE_ENTRY = "codex_apply_patch_usage";

const CODEX_APPLY_PATCH_PROMPT_APPENDIX = `## apply_patch

Use the \`apply_patch\` tool to edit files. Your patch language is a stripped‑down, file‑oriented diff format designed to be easy to parse and safe to apply. You can think of it as a high‑level envelope:

*** Begin Patch
[ one or more file sections ]
*** End Patch

Within that envelope, you get a sequence of file operations.
You MUST include a header to specify the action you are taking.
Each operation starts with one of three headers:

*** Add File: <path> - create a new file. Every following line is a + line (the initial contents).
*** Delete File: <path> - remove an existing file. Nothing follows.
*** Update File: <path> - patch an existing file in place (optionally with a rename).

Example patch:

\`\`\`
*** Begin Patch
*** Add File: hello.txt
+Hello world
*** Update File: src/app.py
*** Move to: src/main.py
@@ def greet():
-print("Hi")
+print("Hello, world!")
*** Delete File: obsolete.txt
*** End Patch
\`\`\`

It is important to remember:

- You must include a header with your intended action (Add/Delete/Update)
- You must prefix new lines with \`+\` even when creating a new file`;

function isCodexPatchModel(model: { id: string } | undefined): model is { id: string } {
	return !!model && supportsApplyPatchModel(model.id);
}

function arraysEqual(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

function patchInputKey(input: string): string {
	return input.replace(/\r\n?/g, "\n").trimEnd();
}

interface ThemeLike {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

interface ApplyPatchRenderDetails {
	stage?: string;
	operations?: number;
	diff?: string;
	filesChanged?: number;
	totalOperations?: number;
	completedOperations?: number;
	currentFile?: string;
	files?: ApplyPatchProgressFile[];
	fileDiffs?: ApplyPatchFileDiff[];
}

interface ApplyPatchRenderFile {
	path: string;
	moveTo?: string;
	operation: "add" | "delete" | "update";
	added: number;
	removed: number;
	done?: boolean;
}

function operationCode(operation: "add" | "delete" | "update"): "A" | "D" | "U" {
	if (operation === "add") return "A";
	if (operation === "delete") return "D";
	return "U";
}

function formatTarget(file: Pick<ApplyPatchRenderFile, "path" | "moveTo">): string {
	return file.moveTo ? `${file.path} -> ${file.moveTo}` : file.path;
}

function formatCounterLine(
	theme: ThemeLike,
	file: ApplyPatchRenderFile,
	options?: { currentFile?: string; showDone?: boolean; includePath?: boolean },
): string {
	const includePath = options?.includePath ?? true;
	let line = `${theme.fg("toolDiffAdded", `+${file.added}`)} ${theme.fg("toolDiffRemoved", `-${file.removed}`)} ${theme.fg("warning", operationCode(file.operation))}`;
	if (includePath) {
		line += ` ${theme.fg("accent", formatTarget(file))}`;
	}
	if (options?.showDone && file.done) {
		line += theme.fg("muted", " ✓");
	} else if (options?.currentFile && options.currentFile === file.path) {
		line += theme.fg("warning", " ← applying");
	}
	return line;
}

export default function codexApplyPatchExtension(pi: ExtensionAPI) {
	let applyPatchUsedInSession = false;
	let warnedOnNonCodexSwitch = false;
	const executingPatchInputs = new Set<string>();
	const completedPatchInputs = new Set<string>();
	const toolsRemovedForCodex = new Set<string>();

	const enforceToolPolicy = (ctx: ExtensionContext) => {
		const codexModel = isCodexPatchModel(ctx.model);
		const active = pi.getActiveTools();
		const allTools = new Set(pi.getAllTools().map((tool) => tool.name));
		const next = active.filter((toolName) => {
			if (!codexModel && toolName === "apply_patch") return false;
			if (codexModel && (toolName === "edit" || toolName === "write")) {
				toolsRemovedForCodex.add(toolName);
				return false;
			}
			return true;
		});

		if (codexModel && !next.includes("apply_patch")) {
			next.push("apply_patch");
		}

		if (!codexModel && toolsRemovedForCodex.size > 0) {
			for (const toolName of toolsRemovedForCodex) {
				if (allTools.has(toolName) && !next.includes(toolName)) {
					next.push(toolName);
				}
			}
			toolsRemovedForCodex.clear();
		}

		if (!arraysEqual(active, next)) {
			pi.setActiveTools(next);
		}
	};

	const refreshUsageState = (ctx: ExtensionContext) => {
		applyPatchUsedInSession = false;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === APPLY_PATCH_USAGE_ENTRY) {
				const data = entry.data as { used?: boolean } | undefined;
				if (data?.used) {
					applyPatchUsedInSession = true;
					break;
				}
			}

			if (entry.type === "message") {
				const message = entry.message;
				if (message.role === "toolResult" && message.toolName === "apply_patch" && !message.isError) {
					applyPatchUsedInSession = true;
					break;
				}
			}
		}
	};

	const refreshSessionState = (_event: unknown, ctx: ExtensionContext) => {
		refreshUsageState(ctx);
		warnedOnNonCodexSwitch = false;
		executingPatchInputs.clear();
		completedPatchInputs.clear();
		toolsRemovedForCodex.clear();
		enforceToolPolicy(ctx);
	};

	pi.on("session_start", refreshSessionState);
	pi.on("session_switch", refreshSessionState);
	pi.on("session_fork", refreshSessionState);
	pi.on("session_tree", refreshSessionState);

	pi.on("before_agent_start", (event, ctx) => {
		enforceToolPolicy(ctx);

		if (!isCodexPatchModel(ctx.model)) return;
		if (event.systemPrompt.includes("## apply_patch")) return;

		return {
			systemPrompt: `${event.systemPrompt}\n\n${CODEX_APPLY_PATCH_PROMPT_APPENDIX}`,
		};
	});

	pi.on("model_select", (event, ctx) => {
		enforceToolPolicy(ctx);

		const movedFromCodex = isCodexPatchModel(event.previousModel);
		const movedToNonCodex = !isCodexPatchModel(event.model);
		if (movedFromCodex && movedToNonCodex && applyPatchUsedInSession && !warnedOnNonCodexSwitch) {
			ctx.ui.notify(
				"This session already used apply_patch on a codex model. apply_patch is now disabled on non-codex models.",
				"warning",
			);
			warnedOnNonCodexSwitch = true;
		}

		if (!movedToNonCodex) {
			warnedOnNonCodexSwitch = false;
		}
	});

	pi.on("tool_call", (event, ctx) => {
		if (event.toolName === "apply_patch") {
			const input = (event.input as { input?: unknown } | undefined)?.input;
			if (typeof input === "string") {
				completedPatchInputs.delete(patchInputKey(input));
			}
		}

		if ((event.toolName === "edit" || event.toolName === "write") && isCodexPatchModel(ctx.model)) {
			return {
				block: true,
				reason: "On codex models, edit/write are disabled by this extension. Use apply_patch instead.",
			};
		}

		if (event.toolName === "apply_patch" && !isCodexPatchModel(ctx.model)) {
			return {
				block: true,
				reason: "apply_patch is only allowed on GPT models (gpt-*).",
			};
		}
	});

	pi.registerTool({
		name: "apply_patch",
		label: "apply_patch",
		description:
			"Edit files using the apply_patch format. Requires *** Begin Patch / *** End Patch with Add/Delete/Update operations.",
		parameters: applyPatchToolSchema,
		renderCall(args, theme) {
			const input = typeof args?.input === "string" ? args.input : "";
			const inputKey = patchInputKey(input);
			const progress = parseApplyPatchInputProgress(input);
			const hidden =
				inputKey.length > 0 && (executingPatchInputs.has(inputKey) || completedPatchInputs.has(inputKey));
			if (hidden) {
				return undefined as unknown as Text;
			}

			let text = theme.fg("toolTitle", theme.bold("apply_patch"));
			if (progress.totalOperations > 0) {
				text += theme.fg("muted", ` (${progress.totalOperations} file${progress.totalOperations === 1 ? "" : "s"})`);
			}
			if (progress.files.length > 0) {
				text += `\n${progress.files.map((file) => formatCounterLine(theme, file, { includePath: true })).join("\n")}`;
			}

			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as ApplyPatchRenderDetails | undefined;
			const textBlock = result.content.find((block) => block.type === "text");
			const baseText = textBlock?.type === "text" ? textBlock.text : "";

			if (isPartial) {
				if (expanded && details?.diff && details.diff.length > 0) {
					return new Text(renderDiff(details.diff), 0, 0);
				}

				if (!expanded && details?.stage === "apply_progress" && Array.isArray(details.files)) {
					if (details.files.length > 0) {
						const count = details.totalOperations ?? details.files.length;
						const title = `${theme.fg("toolTitle", theme.bold("apply_patch"))}${theme.fg("muted", ` (${count} file${count === 1 ? "" : "s"})`)}`;
						const lines = details.files.map((file) => formatCounterLine(theme, file, { includePath: true })).join("\n");
						return new Text(`${title}\n${lines}`, 0, 0);
					}
					const total = details.totalOperations ?? details.files.length;
					const done = details.completedOperations ?? 0;
					return new Text(theme.fg("warning", `Applying patch ${done}/${total}...`), 0, 0);
				}

				return new Text(theme.fg("warning", baseText || "Applying patch..."), 0, 0);
			}

			if (details?.diff && details.diff.length > 0) {
				if (expanded) {
					return new Text(renderDiff(details.diff), 0, 0);
				}
				if (Array.isArray(details.fileDiffs) && details.fileDiffs.length > 0) {
					const count = details.fileDiffs.length;
					const title = `${theme.fg("toolTitle", theme.bold("apply_patch"))}${theme.fg("muted", ` (${count} file${count === 1 ? "" : "s"})`)}`;
					const lines = details.fileDiffs.map((file) => formatCounterLine(theme, file, { includePath: true })).join("\n");
					return new Text(`${title}\n${lines}`, 0, 0);
				}
				return new Text("", 0, 0);
			}

			return new Text(baseText, 0, 0);
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			enforceToolPolicy(ctx);
			const model = ctx.model;
			if (!isCodexPatchModel(model)) {
				return {
					content: [
						{
							type: "text",
							text: "apply_patch is only enabled for GPT models (gpt-*).",
						},
					],
					details: {
						error: true,
						reason: "unsupported_model",
					},
				};
			}

			const inputKey = patchInputKey(params.input);
			executingPatchInputs.add(inputKey);
			completedPatchInputs.delete(inputKey);
			try {
				if (signal?.aborted) {
					throw new Error("apply_patch aborted before validation");
				}

				onUpdate?.({
					content: [{ type: "text", text: "Validating apply_patch payload..." }],
					details: { stage: "validate" },
				});
				const parsed = parseApplyPatch(params.input);

				if (signal?.aborted) {
					throw new Error("apply_patch aborted before filesystem updates");
				}

				const result = await applyParsedPatch(ctx.cwd, parsed, (progress) => {
					onUpdate?.({
						content: [
							{
								type: "text",
								text: `Applying patch ${progress.completedOperations}/${progress.totalOperations}...`,
							},
						],
						details: progress,
					});
				});

				applyPatchUsedInSession = true;
				pi.appendEntry(APPLY_PATCH_USAGE_ENTRY, {
					used: true,
					modelId: model.id,
					timestamp: Date.now(),
				});

				return {
					content: [
						{
							type: "text",
							text: result.codexOutput,
						},
					],
					details: {
						filesChanged: result.filesChanged,
						operations: result.operations,
						fileDiffs: result.fileDiffs,
						diff: result.diff,
					},
				};
			} finally {
				executingPatchInputs.delete(inputKey);
				completedPatchInputs.add(inputKey);
			}
		},
	});

	pi.registerProvider("openai-codex", {
		api: "openai-codex-responses",
		streamSimple: streamSimpleCodexWithCustomApplyPatch,
	});
}
