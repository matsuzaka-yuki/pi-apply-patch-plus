import { describe, expect, it } from "vitest";
import { parseApplyPatchInputProgress } from "./apply-patch-progress.js";

describe("parseApplyPatchInputProgress", () => {
	it("tracks counts from partial streamed input", () => {
		const progress = parseApplyPatchInputProgress(`*** Begin Patch
*** Update File: src/app.ts
@@
-old line
+new line`);

		expect(progress.totalOperations).toBe(1);
		expect(progress.ended).toBe(false);
		expect(progress.files).toEqual([
			{
				path: "src/app.ts",
				operation: "update",
				added: 1,
				removed: 1,
			},
		]);
	});

	it("tracks add/delete/update and move targets", () => {
		const progress = parseApplyPatchInputProgress(`*** Begin Patch
*** Add File: a.txt
+hello
+world
*** Delete File: b.txt
*** Update File: old.ts
*** Move to: new.ts
@@
-old
+new
*** End Patch
`);

		expect(progress.totalOperations).toBe(3);
		expect(progress.ended).toBe(true);
		expect(progress.files).toEqual([
			{ path: "a.txt", operation: "add", added: 2, removed: 0 },
			{ path: "b.txt", operation: "delete", added: 0, removed: 0 },
			{ path: "old.ts", moveTo: "new.ts", operation: "update", added: 1, removed: 1 },
		]);
	});

	it("ignores content before begin patch", () => {
		const progress = parseApplyPatchInputProgress(`random preface
*** Begin Patch
*** Add File: only.txt
+ok`);
		expect(progress.totalOperations).toBe(1);
		expect(progress.files[0]?.path).toBe("only.txt");
	});
});
