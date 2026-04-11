import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { validateRequiredOutput } from "./subagent-runner.ts";

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (!dir) continue;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("validateRequiredOutput", () => {
	it("fails when required output text is empty", () => {
		const result = validateRequiredOutput("/tmp/required-output.md", "   \n\t  ");
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.match(result.error, /required text output/);
		}
	});

	it("persists and verifies non-empty required output", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-required-output-"));
		tempDirs.push(dir);
		const outputPath = path.join(dir, "review.md");

		const result = validateRequiredOutput(outputPath, "hello world");
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.savedPath, outputPath);
			assert.equal(fs.readFileSync(outputPath, "utf-8"), "hello world");
		}
	});
});
