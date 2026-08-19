import { describe, expect, it } from "vitest";
import {
	convertCodexTools,
	convertContextToInput,
	supportsApplyPatchModel,
	supportsCustomApplyPatchModel,
} from "./codex-provider.js";

describe("supportsCustomApplyPatchModel", () => {
	it("matches codex 5.2 and 5.3 variants", () => {
		expect(supportsCustomApplyPatchModel("gpt-5.2-codex")).toBe(true);
		expect(supportsCustomApplyPatchModel("gpt-5.3-codex")).toBe(true);
		expect(supportsCustomApplyPatchModel("gpt-5.3-codex-spark")).toBe(true);
		expect(supportsCustomApplyPatchModel("gpt-5.1-codex")).toBe(false);
		expect(supportsCustomApplyPatchModel("gpt-5.3")).toBe(false);
		expect(supportsCustomApplyPatchModel("gpt-5.6-sol")).toBe(false);
	});
});

describe("supportsApplyPatchModel", () => {
	it("enables any GPT-family model", () => {
		expect(supportsApplyPatchModel("gpt-5.2-codex")).toBe(true);
		expect(supportsApplyPatchModel("gpt-5.3-codex-spark")).toBe(true);
		expect(supportsApplyPatchModel("gpt-5.6-sol")).toBe(true);
		expect(supportsApplyPatchModel("gpt-5.6-luna")).toBe(true);
		expect(supportsApplyPatchModel("gpt-5.6-terra")).toBe(true);
		expect(supportsApplyPatchModel("gpt-4o")).toBe(true);
		expect(supportsApplyPatchModel("GPT-5.6-SOL")).toBe(true);
	});

	it("excludes non-GPT models", () => {
		expect(supportsApplyPatchModel("claude-sonnet-4-5")).toBe(false);
		expect(supportsApplyPatchModel("deepseek-v4-pro-0813")).toBe(false);
		expect(supportsApplyPatchModel("glm-5.3")).toBe(false);
		expect(supportsApplyPatchModel("my-gpt-5.6")).toBe(false);
	});
});

describe("convertCodexTools", () => {
	const tools = [
		{
			name: "apply_patch",
			description: "patch tool",
			parameters: { type: "object", properties: { input: { type: "string" } } },
		},
		{
			name: "read",
			description: "read tool",
			parameters: { type: "object", properties: { path: { type: "string" } } },
		},
	] as any;

	it("uses custom tool definition for apply_patch when enabled", () => {
		const converted = convertCodexTools(tools, true);
		expect(converted[0]).toMatchObject({ type: "custom", name: "apply_patch" });
		expect(converted[1]).toMatchObject({ type: "function", name: "read" });
	});

	it("uses function tool definition when disabled", () => {
		const converted = convertCodexTools(tools, false);
		expect(converted[0]).toMatchObject({ type: "function", name: "apply_patch" });
		expect(converted[1]).toMatchObject({ type: "function", name: "read" });
	});
});

describe("convertContextToInput", () => {
	const model = { input: ["text", "image"] } as any;

	it("synthesizes cancellation output for orphaned custom tool calls", () => {
		const context = {
			messages: [
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "call_orphan|ct_orphan",
							name: "apply_patch",
							arguments: { input: "*** Begin Patch\n*** End Patch" },
						},
					],
				},
				{
					role: "user",
					content: "continue",
				},
			],
		} as any;

		const input = convertContextToInput(model, context) as Array<Record<string, unknown>>;
		const customOutput = input.find((item) => item.type === "custom_tool_call_output");

		expect(customOutput).toBeTruthy();
		expect(customOutput?.call_id).toBe("call_orphan");
		expect(String(customOutput?.output ?? "")).toContain("cancelled");
	});

	it("does not synthesize cancellation output when tool result exists", () => {
		const context = {
			messages: [
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "call_done|ct_done",
							name: "apply_patch",
							arguments: { input: "*** Begin Patch\n*** End Patch" },
						},
					],
				},
				{
					role: "toolResult",
					toolCallId: "call_done|ct_done",
					toolName: "apply_patch",
					content: [{ type: "text", text: "ok" }],
				},
			],
		} as any;

		const input = convertContextToInput(model, context) as Array<Record<string, unknown>>;
		const outputs = input.filter((item) => item.type === "custom_tool_call_output");

		expect(outputs).toHaveLength(1);
		expect(outputs[0]?.output).toBe("ok");
	});
});
