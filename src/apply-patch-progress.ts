import type { PatchOperation } from "./apply-patch.js";

export interface ApplyPatchInputProgressFile {
	path: string;
	moveTo?: string;
	operation: PatchOperation["type"];
	added: number;
	removed: number;
}

export interface ApplyPatchInputProgress {
	totalOperations: number;
	files: ApplyPatchInputProgressFile[];
	ended: boolean;
}

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const ADD = "*** Add File: ";
const DELETE = "*** Delete File: ";
const UPDATE = "*** Update File: ";
const MOVE = "*** Move to: ";

/**
 * Best-effort parser for live/partial apply_patch input.
 * Works on incomplete tool-call payloads while arguments stream in.
 */
export function parseApplyPatchInputProgress(input: string): ApplyPatchInputProgress {
	const normalized = input.replace(/\r\n?/g, "\n");
	const lines = normalized.split("\n");
	const files: ApplyPatchInputProgressFile[] = [];

	let inPatch = false;
	let ended = false;
	let current: ApplyPatchInputProgressFile | undefined;

	for (const line of lines) {
		if (!inPatch) {
			if (line === BEGIN) inPatch = true;
			continue;
		}

		if (line === END) {
			ended = true;
			break;
		}

		if (line.startsWith(ADD)) {
			current = {
				path: line.slice(ADD.length),
				operation: "add",
				added: 0,
				removed: 0,
			};
			files.push(current);
			continue;
		}

		if (line.startsWith(DELETE)) {
			current = {
				path: line.slice(DELETE.length),
				operation: "delete",
				added: 0,
				removed: 0,
			};
			files.push(current);
			continue;
		}

		if (line.startsWith(UPDATE)) {
			current = {
				path: line.slice(UPDATE.length),
				operation: "update",
				added: 0,
				removed: 0,
			};
			files.push(current);
			continue;
		}

		if (line.startsWith(MOVE) && current?.operation === "update") {
			current.moveTo = line.slice(MOVE.length);
			continue;
		}

		if (!current) continue;

		if (current.operation === "add") {
			if (line.startsWith("+")) {
				current.added += 1;
			}
			continue;
		}

		if (current.operation === "update") {
			if (line.startsWith("+")) {
				current.added += 1;
			} else if (line.startsWith("-")) {
				current.removed += 1;
			}
		}
	}

	return {
		totalOperations: files.length,
		files,
		ended,
	};
}
