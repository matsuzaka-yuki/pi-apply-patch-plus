import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyParsedPatch, applyPatch, parseApplyPatch } from "./apply-patch.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await mkdtemp(path.join(os.tmpdir(), "pi-codex-apply-patch-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	for (const dir of tempDirs.splice(0, tempDirs.length)) {
		await rm(dir, { recursive: true, force: true });
	}
});

describe("parseApplyPatch", () => {
	it("parses add/update/delete operations", () => {
		const parsed = parseApplyPatch(`*** Begin Patch
*** Add File: a.txt
+hello
*** Update File: b.txt
@@
-old
+new
*** Delete File: c.txt
*** End Patch
`);

		expect(parsed.operations).toHaveLength(3);
		expect(parsed.operations[0]).toMatchObject({ type: "add", filePath: "a.txt" });
		expect(parsed.operations[1]).toMatchObject({ type: "update", filePath: "b.txt" });
		expect(parsed.operations[2]).toMatchObject({ type: "delete", filePath: "c.txt" });
	});

	it("normalizes CRLF line endings", () => {
		const parsed = parseApplyPatch("*** Begin Patch\r\n*** Add File: a.txt\r\n+hello\r\n*** End Patch\r\n");
		expect(parsed.operations).toHaveLength(1);
		expect(parsed.operations[0]).toMatchObject({ type: "add", filePath: "a.txt" });
	});

	it("parses move + hunk metadata", () => {
		const parsed = parseApplyPatch(`*** Begin Patch
*** Update File: old.txt
*** Move to: new.txt
@@ header
 line1
-line2
+line2b
*** End of File
*** End Patch
`);
		expect(parsed.operations).toHaveLength(1);
		expect(parsed.operations[0]).toMatchObject({
			type: "update",
			filePath: "old.txt",
			moveTo: "new.txt",
		});
	});

	it("rejects malformed envelopes", () => {
		expect(() => parseApplyPatch("*** Add File: a.txt\n+hello\n*** End Patch\n")).toThrow(
			/Patch must start/,
		);
		expect(() => parseApplyPatch("*** Begin Patch\n*** Add File: a.txt\n+hello")).toThrow(/must end/);
		expect(() =>
			parseApplyPatch("*** Begin Patch\n*** Update File: a.txt\n*** End Patch\n"),
		).toThrow(/must include at least one hunk/);
	});
});

describe("applyPatch", () => {
	it("adds and updates files", async () => {
		const cwd = await makeTempDir();
		await writeFile(path.join(cwd, "app.txt"), "line1\nline2\n", "utf8");

		const result = await applyPatch(
			cwd,
			`*** Begin Patch
*** Add File: hello.txt
+hello world
*** Update File: app.txt
@@
 line1
-line2
+line2 updated
*** End Patch
`,
		);

		expect(result.filesChanged).toBe(2);
		expect(await readFile(path.join(cwd, "hello.txt"), "utf8")).toBe("hello world");
		expect(await readFile(path.join(cwd, "app.txt"), "utf8")).toBe("line1\nline2 updated\n");
		expect(result.codexOutput).toBe("Success. Updated the following files:\nA hello.txt\nM app.txt\n");
	});

	it("moves files with update", async () => {
		const cwd = await makeTempDir();
		await writeFile(path.join(cwd, "old.ts"), "export const n = 1;\n", "utf8");

		await applyPatch(
			cwd,
			`*** Begin Patch
*** Update File: old.ts
*** Move to: src/new.ts
@@
-export const n = 1;
+export const n = 2;
*** End Patch
`,
		);

		await expect(readFile(path.join(cwd, "old.ts"), "utf8")).rejects.toThrow();
		expect(await readFile(path.join(cwd, "src/new.ts"), "utf8")).toBe("export const n = 2;\n");
	});

	it("allows absolute paths", async () => {
		const cwd = await makeTempDir();
		const target = path.join(cwd, "absolute.txt");

		await applyPatch(
			cwd,
			`*** Begin Patch
*** Add File: ${target}
+ok
*** End Patch
`,
		);

		expect(await readFile(target, "utf8")).toBe("ok");
	});

	it("deletes files", async () => {
		const cwd = await makeTempDir();
		await writeFile(path.join(cwd, "remove-me.txt"), "bye\n", "utf8");

		const result = await applyPatch(
			cwd,
			`*** Begin Patch
*** Delete File: remove-me.txt
*** End Patch
`,
		);

		expect(result.operations).toEqual(["delete remove-me.txt"]);
		await expect(readFile(path.join(cwd, "remove-me.txt"), "utf8")).rejects.toThrow();
	});

	it("formats codex success output in A/M/D order", async () => {
		const cwd = await makeTempDir();
		await writeFile(path.join(cwd, "modify.txt"), "one\n", "utf8");
		await writeFile(path.join(cwd, "delete.txt"), "gone\n", "utf8");

		const result = await applyPatch(
			cwd,
			`*** Begin Patch
*** Add File: add.txt
+new
*** Update File: modify.txt
@@
-one
+two
*** Delete File: delete.txt
*** End Patch
`,
		);

		expect(result.codexOutput).toBe(
			"Success. Updated the following files:\nA add.txt\nM modify.txt\nD delete.txt\n",
		);
	});

	it("allows parent-relative paths like write tool", async () => {
		const root = await makeTempDir();
		const cwd = path.join(root, "nested");
		await mkdir(cwd, { recursive: true });

		await applyPatch(
			cwd,
			`*** Begin Patch
*** Add File: ../escape.txt
+ok
*** End Patch
`,
		);

		expect(await readFile(path.join(root, "escape.txt"), "utf8")).toBe("ok");
	});

	it("applies multiple hunks in order", async () => {
		const cwd = await makeTempDir();
		await writeFile(path.join(cwd, "multi.txt"), "a\nb\nc\nd\n", "utf8");

		await applyPatch(
			cwd,
			`*** Begin Patch
*** Update File: multi.txt
@@
 a
-b
+b2
 c
@@
 c
-d
+d2
*** End Patch
`,
		);

		expect(await readFile(path.join(cwd, "multi.txt"), "utf8")).toBe("a\nb2\nc\nd2\n");
	});

	it("fails on context mismatch", async () => {
		const cwd = await makeTempDir();
		await writeFile(path.join(cwd, "ctx.txt"), "one\ntwo\n", "utf8");

		await expect(
			applyPatch(
				cwd,
				`*** Begin Patch
*** Update File: ctx.txt
@@
 not-here
-two
+two-updated
*** End Patch
`,
			),
		).rejects.toThrow(/Context mismatch/);
	});

	it("rejects add when destination already exists", async () => {
		const cwd = await makeTempDir();
		await writeFile(path.join(cwd, "exists.txt"), "already\n", "utf8");

		await expect(
			applyPatch(
				cwd,
				`*** Begin Patch
*** Add File: exists.txt
+new
*** End Patch
`,
			),
		).rejects.toThrow(/already exists/);
	});

	it("rejects move when destination already exists", async () => {
		const cwd = await makeTempDir();
		await writeFile(path.join(cwd, "src.txt"), "from\n", "utf8");
		await writeFile(path.join(cwd, "dest.txt"), "to\n", "utf8");

		await expect(
			applyPatch(
				cwd,
				`*** Begin Patch
*** Update File: src.txt
*** Move to: dest.txt
@@
-from
+from2
*** End Patch
`,
			),
		).rejects.toThrow(/destination already exists/);
	});

	it("emits per-file progress updates", async () => {
		const cwd = await makeTempDir();
		await writeFile(path.join(cwd, "multi.txt"), "a\nb\nc\nd\n", "utf8");

		const parsed = parseApplyPatch(`*** Begin Patch
*** Update File: multi.txt
@@
 a
-b
+b2
 c
@@
 c
-d
+d2
*** End Patch
`);

		const snapshots: Array<{ completedOperations: number; added: number; removed: number; done: boolean }> = [];
		await applyParsedPatch(cwd, parsed, (progress) => {
			const file = progress.files[0];
			if (!file) return;
			snapshots.push({
				completedOperations: progress.completedOperations,
				added: file.added,
				removed: file.removed,
				done: file.done,
			});
		});

		expect(snapshots.length).toBeGreaterThanOrEqual(3);
		expect(snapshots[0]).toMatchObject({ completedOperations: 0, added: 0, removed: 0, done: false });
		expect(snapshots[snapshots.length - 1]).toMatchObject({
			completedOperations: 1,
			added: 2,
			removed: 2,
			done: true,
		});
	});
});
