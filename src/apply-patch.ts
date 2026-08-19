import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const APPLY_PATCH_GRAMMAR = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF`;

export type PatchOperation =
	| { type: "add"; filePath: string; lines: string[] }
	| { type: "delete"; filePath: string }
	| { type: "update"; filePath: string; moveTo?: string; hunks: PatchHunk[] };

export interface PatchHunk {
	header?: string;
	lines: Array<{ type: "context" | "add" | "remove"; text: string }>;
}

export interface ParsedPatch {
	operations: PatchOperation[];
}

export interface ApplyPatchFileDiff {
	path: string;
	moveTo?: string;
	operation: PatchOperation["type"];
	added: number;
	removed: number;
	diff: string;
	firstChangedLine?: number;
}

export interface ApplyPatchResult {
	operations: string[];
	filesChanged: number;
	fileDiffs: ApplyPatchFileDiff[];
	diff: string;
	codexOutput: string;
}

export interface ApplyPatchProgressFile {
	path: string;
	moveTo?: string;
	operation: PatchOperation["type"];
	added: number;
	removed: number;
	done: boolean;
}

export interface ApplyPatchProgress {
	stage: "apply_progress";
	totalOperations: number;
	completedOperations: number;
	currentFile?: string;
	files: ApplyPatchProgressFile[];
	fileDiffs: ApplyPatchFileDiff[];
	diff: string;
}

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const ADD = "*** Add File: ";
const DELETE = "*** Delete File: ";
const UPDATE = "*** Update File: ";
const MOVE = "*** Move to: ";
const END_OF_FILE = "*** End of File";

export function parseApplyPatch(input: string): ParsedPatch {
	const normalized = input.replace(/\r\n?/g, "\n");
	const lines = normalized.split("\n");

	if (lines[0] !== BEGIN) {
		throw new Error("Patch must start with '*** Begin Patch'.");
	}

	let index = 1;
	const operations: PatchOperation[] = [];
	let foundEnd = false;

	while (index < lines.length) {
		const line = lines[index]!;

		if (line === END) {
			foundEnd = true;
			index += 1;
			break;
		}

		if (line.startsWith(ADD)) {
			const filePath = line.slice(ADD.length);
			if (!filePath) throw new Error("Add File requires a path.");
			index += 1;
			const addLines: string[] = [];
			while (index < lines.length && !isPatchBoundary(lines[index]!)) {
				const addLine = lines[index]!;
				if (!addLine.startsWith("+")) {
					throw new Error(`Add File lines must start with '+': ${addLine}`);
				}
				addLines.push(addLine.slice(1));
				index += 1;
			}
			if (addLines.length === 0) throw new Error(`Add File '${filePath}' has no content lines.`);
			operations.push({ type: "add", filePath, lines: addLines });
			continue;
		}

		if (line.startsWith(DELETE)) {
			const filePath = line.slice(DELETE.length);
			if (!filePath) throw new Error("Delete File requires a path.");
			operations.push({ type: "delete", filePath });
			index += 1;
			continue;
		}

		if (line.startsWith(UPDATE)) {
			const filePath = line.slice(UPDATE.length);
			if (!filePath) throw new Error("Update File requires a path.");
			index += 1;

			let moveTo: string | undefined;
			if (index < lines.length && lines[index]!.startsWith(MOVE)) {
				moveTo = lines[index]!.slice(MOVE.length);
				if (!moveTo) throw new Error(`Update File '${filePath}' has empty move destination.`);
				index += 1;
			}

			const hunks: PatchHunk[] = [];
			while (index < lines.length && !isPatchBoundary(lines[index]!)) {
				const hunkHeader = lines[index]!;
				if (!hunkHeader.startsWith("@@")) {
					throw new Error(`Expected hunk header starting with @@, got: ${hunkHeader}`);
				}
				index += 1;

				const hunkLines: PatchHunk["lines"] = [];
				while (index < lines.length) {
					const hunkLine = lines[index]!;
					if (hunkLine === END_OF_FILE) {
						index += 1;
						break;
					}
					if (hunkLine.startsWith("@@") || isPatchBoundary(hunkLine)) {
						break;
					}

					const prefix = hunkLine[0];
					if (prefix === " ") {
						hunkLines.push({ type: "context", text: hunkLine.slice(1) });
					} else if (prefix === "+") {
						hunkLines.push({ type: "add", text: hunkLine.slice(1) });
					} else if (prefix === "-") {
						hunkLines.push({ type: "remove", text: hunkLine.slice(1) });
					} else {
						throw new Error(`Hunk lines must start with ' ', '+', or '-': ${hunkLine}`);
					}
					index += 1;
				}

				if (hunkLines.length === 0) {
					throw new Error(`Update File '${filePath}' has an empty hunk.`);
				}

				hunks.push({
					header: hunkHeader.length > 2 ? hunkHeader.slice(2).trimStart() : undefined,
					lines: hunkLines,
				});
			}

			if (hunks.length === 0) {
				throw new Error(`Update File '${filePath}' must include at least one hunk.`);
			}

			operations.push({ type: "update", filePath, moveTo, hunks });
			continue;
		}

		throw new Error(`Unrecognized patch line: ${line}`);
	}

	if (!foundEnd) {
		throw new Error("Patch must end with '*** End Patch'.");
	}

	for (; index < lines.length; index += 1) {
		if (lines[index]!.trim().length > 0) {
			throw new Error("Unexpected content after '*** End Patch'.");
		}
	}

	if (operations.length === 0) {
		throw new Error("Patch must contain at least one file operation.");
	}

	return { operations };
}

function isPatchBoundary(line: string): boolean {
	return line === END || line.startsWith(ADD) || line.startsWith(DELETE) || line.startsWith(UPDATE);
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function normalizeUnicodeSpaces(str: string): string {
	return str.replace(UNICODE_SPACES, " ");
}

function normalizeAtPrefix(filePath: string): string {
	return filePath.startsWith("@") ? filePath.slice(1) : filePath;
}

function expandPath(filePath: string): string {
	const normalized = normalizeUnicodeSpaces(normalizeAtPrefix(filePath));
	if (normalized === "~") {
		return os.homedir();
	}
	if (normalized.startsWith("~/")) {
		return os.homedir() + normalized.slice(1);
	}
	return normalized;
}

function resolveRelativePathSafe(cwd: string, filePath: string): string {
	if (!filePath.trim()) throw new Error("Patch path cannot be empty.");
	const expanded = expandPath(filePath);
	if (path.isAbsolute(expanded)) {
		return path.resolve(expanded);
	}
	return path.resolve(path.resolve(cwd), expanded);
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await stat(filePath);
		return true;
	} catch {
		return false;
	}
}

function countContentLines(content: string): number {
	if (content.length === 0) return 0;
	const lines = content.split("\n");
	return content.endsWith("\n") ? lines.length - 1 : lines.length;
}

function applyHunksToContent(
	originalContent: string,
	hunks: PatchHunk[],
	filePath: string,
	onHunkApplied?: (delta: { hunkIndex: number; added: number; removed: number; currentContent: string }) => void,
): string {
	const lines = originalContent.split("\n");
	let cursor = 0;

	for (const [hunkIndex, hunk] of hunks.entries()) {
		const oldChunk = hunk.lines.filter((line) => line.type !== "add").map((line) => line.text);
		const newChunk = hunk.lines.filter((line) => line.type !== "remove").map((line) => line.text);

		const matchAt = findBestMatchIndex(lines, oldChunk, cursor);
		if (matchAt < 0) {
			const hint = hunk.header ? ` (${hunk.header})` : "";
			throw new Error(
				`Could not apply hunk ${hunkIndex + 1}${hint} in '${filePath}'. Context mismatch.`,
			);
		}

		lines.splice(matchAt, oldChunk.length, ...newChunk);
		cursor = matchAt + newChunk.length;

		onHunkApplied?.({
			hunkIndex,
			added: hunk.lines.filter((line) => line.type === "add").length,
			removed: hunk.lines.filter((line) => line.type === "remove").length,
			currentContent: lines.join("\n"),
		});
	}

	return lines.join("\n");
}

function findBestMatchIndex(lines: string[], chunk: string[], fromIndex: number): number {
	if (chunk.length === 0) return Math.max(0, Math.min(fromIndex, lines.length));

	const lastStart = lines.length - chunk.length;
	const search = (start: number, end: number): number => {
		for (let i = start; i <= end; i += 1) {
			let ok = true;
			for (let j = 0; j < chunk.length; j += 1) {
				if (lines[i + j] !== chunk[j]) {
					ok = false;
					break;
				}
			}
			if (ok) return i;
		}
		return -1;
	};

	if (lastStart < 0) return -1;
	const clampedStart = Math.max(0, Math.min(fromIndex, lastStart));
	const forward = search(clampedStart, lastStart);
	if (forward >= 0) return forward;
	if (clampedStart > 0) {
		return search(0, clampedStart - 1);
	}
	return -1;
}

function generateNumberedDiff(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const lineNumWidth = String(Math.max(oldLines.length, newLines.length, 1)).length;

	type Segment = { type: "equal" | "add" | "remove"; lines: string[] };
	const lcs = Array.from({ length: oldLines.length + 1 }, () => Array<number>(newLines.length + 1).fill(0));
	for (let i = oldLines.length - 1; i >= 0; i -= 1) {
		for (let j = newLines.length - 1; j >= 0; j -= 1) {
			if (oldLines[i] === newLines[j]) lcs[i][j] = lcs[i + 1][j + 1] + 1;
			else lcs[i][j] = Math.max(lcs[i + 1][j], lcs[i][j + 1]);
		}
	}

	const segments: Segment[] = [];
	let i = 0;
	let j = 0;
	const push = (type: Segment["type"], line: string) => {
		const last = segments[segments.length - 1];
		if (last && last.type === type) last.lines.push(line);
		else segments.push({ type, lines: [line] });
	};

	while (i < oldLines.length && j < newLines.length) {
		if (oldLines[i] === newLines[j]) {
			push("equal", oldLines[i]!);
			i += 1;
			j += 1;
		} else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
			push("remove", oldLines[i]!);
			i += 1;
		} else {
			push("add", newLines[j]!);
			j += 1;
		}
	}
	while (i < oldLines.length) {
		push("remove", oldLines[i]!);
		i += 1;
	}
	while (j < newLines.length) {
		push("add", newLines[j]!);
		j += 1;
	}

	const output: string[] = [];
	let oldLineNum = 1;
	let newLineNum = 1;
	let firstChangedLine: number | undefined;
	let lastWasChange = false;

	for (let index = 0; index < segments.length; index += 1) {
		const segment = segments[index]!;
		if (segment.type === "add" || segment.type === "remove") {
			if (firstChangedLine === undefined) firstChangedLine = newLineNum;
			for (const line of segment.lines) {
				if (segment.type === "add") {
					output.push(`+${String(newLineNum).padStart(lineNumWidth, " ")} ${line}`);
					newLineNum += 1;
				} else {
					output.push(`-${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
					oldLineNum += 1;
				}
			}
			lastWasChange = true;
			continue;
		}

		const nextIsChange =
			index < segments.length - 1 &&
			(segments[index + 1]!.type === "add" || segments[index + 1]!.type === "remove");
		if (lastWasChange || nextIsChange) {
			let linesToShow = segment.lines;
			let skipStart = 0;
			let skipEnd = 0;

			if (!lastWasChange) {
				skipStart = Math.max(0, linesToShow.length - contextLines);
				linesToShow = linesToShow.slice(skipStart);
			}
			if (!nextIsChange && linesToShow.length > contextLines) {
				skipEnd = linesToShow.length - contextLines;
				linesToShow = linesToShow.slice(0, contextLines);
			}

			if (skipStart > 0) {
				output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
				oldLineNum += skipStart;
				newLineNum += skipStart;
			}
			for (const line of linesToShow) {
				output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
				oldLineNum += 1;
				newLineNum += 1;
			}
			if (skipEnd > 0) {
				output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
				oldLineNum += skipEnd;
				newLineNum += skipEnd;
			}
		} else {
			oldLineNum += segment.lines.length;
			newLineNum += segment.lines.length;
		}

		lastWasChange = false;
	}

	return { diff: output.join("\n"), firstChangedLine };
}

function operationCode(operation: PatchOperation["type"]): "A" | "D" | "U" {
	if (operation === "add") return "A";
	if (operation === "delete") return "D";
	return "U";
}

function buildCodexSuccessOutput(fileDiffs: ApplyPatchFileDiff[]): string {
	const added: string[] = [];
	const modified: string[] = [];
	const deleted: string[] = [];

	for (const fileDiff of fileDiffs) {
		if (fileDiff.operation === "add") {
			added.push(fileDiff.path);
			continue;
		}
		if (fileDiff.operation === "delete") {
			deleted.push(fileDiff.path);
			continue;
		}
		modified.push(fileDiff.moveTo ?? fileDiff.path);
	}

	const lines: string[] = ["Success. Updated the following files:"];
	for (const path of added) lines.push(`A ${path}`);
	for (const path of modified) lines.push(`M ${path}`);
	for (const path of deleted) lines.push(`D ${path}`);
	return `${lines.join("\n")}\n`;
}

function combineFileDiffs(fileDiffs: ApplyPatchFileDiff[]): string {
	return fileDiffs
		.map((fileDiff) => {
			const target = fileDiff.moveTo ? `${fileDiff.path} -> ${fileDiff.moveTo}` : fileDiff.path;
			const header = `@@ +${fileDiff.added} -${fileDiff.removed} ${operationCode(fileDiff.operation)} ${target}`;
			return [header, fileDiff.diff].filter(Boolean).join("\n");
		})
		.join("\n\n");
}

export async function applyParsedPatch(
	cwd: string,
	parsedPatch: ParsedPatch,
	onProgress?: (progress: ApplyPatchProgress) => void,
): Promise<ApplyPatchResult> {
	const operations: string[] = [];
	const fileDiffs: ApplyPatchFileDiff[] = [];
	let filesChanged = 0;

	const progressFiles: ApplyPatchProgressFile[] = parsedPatch.operations.map((op) => ({
		path: op.filePath,
		moveTo: op.type === "update" ? op.moveTo : undefined,
		operation: op.type,
		added: 0,
		removed: 0,
		done: false,
	}));

	const emitProgress = (
		completedOperations: number,
		currentFileIndex?: number,
		liveFileDiff?: ApplyPatchFileDiff,
	) => {
		const emittedFileDiffs = liveFileDiff ? [...fileDiffs, liveFileDiff] : [...fileDiffs];
		onProgress?.({
			stage: "apply_progress",
			totalOperations: parsedPatch.operations.length,
			completedOperations,
			currentFile: currentFileIndex === undefined ? undefined : progressFiles[currentFileIndex]?.path,
			files: progressFiles.map((file) => ({ ...file })),
			fileDiffs: emittedFileDiffs.map((fileDiff) => ({ ...fileDiff })),
			diff: combineFileDiffs(emittedFileDiffs),
		});
	};

	if (parsedPatch.operations.length > 0) {
		emitProgress(0, 0);
	}

	for (const [opIndex, op] of parsedPatch.operations.entries()) {
		const progressFile = progressFiles[opIndex]!;
		if (op.type === "add") {
			const absPath = resolveRelativePathSafe(cwd, op.filePath);
			if (await fileExists(absPath)) {
				throw new Error(`Cannot add file '${op.filePath}': file already exists.`);
			}
			const nextContent = op.lines.join("\n");
			await mkdir(path.dirname(absPath), { recursive: true });
			await writeFile(absPath, nextContent, "utf8");
			operations.push(`add ${op.filePath}`);
			const diff = generateNumberedDiff("", nextContent);
			fileDiffs.push({
				path: op.filePath,
				operation: "add",
				added: op.lines.length,
				removed: 0,
				diff: diff.diff,
				firstChangedLine: diff.firstChangedLine,
			});
			progressFile.added = op.lines.length;
			progressFile.done = true;
			filesChanged += 1;
			emitProgress(opIndex + 1, opIndex);
			continue;
		}

		if (op.type === "delete") {
			const absPath = resolveRelativePathSafe(cwd, op.filePath);
			if (!(await fileExists(absPath))) {
				throw new Error(`Cannot delete file '${op.filePath}': file does not exist.`);
			}
			const oldContent = await readFile(absPath, "utf8");
			await rm(absPath);
			operations.push(`delete ${op.filePath}`);
			const removed = countContentLines(oldContent);
			const diff = generateNumberedDiff(oldContent, "");
			fileDiffs.push({
				path: op.filePath,
				operation: "delete",
				added: 0,
				removed,
				diff: diff.diff,
				firstChangedLine: diff.firstChangedLine,
			});
			progressFile.removed = removed;
			progressFile.done = true;
			filesChanged += 1;
			emitProgress(opIndex + 1, opIndex);
			continue;
		}

		const absPath = resolveRelativePathSafe(cwd, op.filePath);
		if (!(await fileExists(absPath))) {
			throw new Error(`Cannot update file '${op.filePath}': file does not exist.`);
		}

		const original = await readFile(absPath, "utf8");
		const updated = applyHunksToContent(original, op.hunks, op.filePath, ({ added, removed, currentContent }) => {
			progressFile.added += added;
			progressFile.removed += removed;
			const live = generateNumberedDiff(original, currentContent);
			emitProgress(opIndex, opIndex, {
				path: op.filePath,
				moveTo: op.moveTo,
				operation: "update",
				added: progressFile.added,
				removed: progressFile.removed,
				diff: live.diff,
				firstChangedLine: live.firstChangedLine,
			});
		});
		const diff = generateNumberedDiff(original, updated);

		if (op.moveTo) {
			const absMoveTo = resolveRelativePathSafe(cwd, op.moveTo);
			if (await fileExists(absMoveTo)) {
				throw new Error(`Cannot move '${op.filePath}' to '${op.moveTo}': destination already exists.`);
			}
			await mkdir(path.dirname(absMoveTo), { recursive: true });
			await writeFile(absMoveTo, updated, "utf8");
			await rm(absPath);
			operations.push(`update+move ${op.filePath} -> ${op.moveTo}`);
			fileDiffs.push({
				path: op.filePath,
				moveTo: op.moveTo,
				operation: "update",
				added: progressFile.added,
				removed: progressFile.removed,
				diff: diff.diff,
				firstChangedLine: diff.firstChangedLine,
			});
		} else {
			await writeFile(absPath, updated, "utf8");
			operations.push(`update ${op.filePath}`);
			fileDiffs.push({
				path: op.filePath,
				operation: "update",
				added: progressFile.added,
				removed: progressFile.removed,
				diff: diff.diff,
				firstChangedLine: diff.firstChangedLine,
			});
		}

		progressFile.done = true;
		filesChanged += 1;
		emitProgress(opIndex + 1, opIndex);
	}

	return {
		operations,
		filesChanged,
		fileDiffs,
		diff: combineFileDiffs(fileDiffs),
		codexOutput: buildCodexSuccessOutput(fileDiffs),
	};
}

export async function applyPatch(cwd: string, patchText: string): Promise<ApplyPatchResult> {
	const parsed = parseApplyPatch(patchText);
	return applyParsedPatch(cwd, parsed);
}
