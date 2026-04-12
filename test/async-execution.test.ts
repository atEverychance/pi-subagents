/**
 * Integration tests for async (background) agent execution.
 *
 * Tests the async support utilities: jiti availability check,
 * status file reading/caching.
 *
 * Requires pi packages to be importable. Skips gracefully if unavailable.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createTempDir, makeAgent, removeTempDir, tryImport } from "./helpers.ts";

// Top-level await
const asyncMod = await tryImport<any>("./async-execution.ts");
const utils = await tryImport<any>("./utils.ts");
const available = !!(asyncMod && utils);

const isAsyncAvailable = asyncMod?.isAsyncAvailable;
const executeAsyncChain = asyncMod?.executeAsyncChain;
const readStatus = utils?.readStatus;

function findDeadPid(): number {
	for (let candidate = 900_000; candidate < 901_000; candidate++) {
		try {
			process.kill(candidate, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code === "ESRCH") {
				return candidate;
			}
		}
	}
	return 9_999_999;
}

describe("async execution utilities", { skip: !available ? "pi packages not available" : undefined }, () => {
	it("reports jiti availability as boolean", () => {
		const result = isAsyncAvailable();
		assert.equal(typeof result, "boolean");
	});

	it("readStatus returns null for missing directory", () => {
		const status = readStatus("/nonexistent/path/abc123");
		assert.equal(status, null);
	});

	it("readStatus parses valid status file", () => {
		const dir = createTempDir();
		try {
			const statusData = {
				runId: "test-123",
				state: "running",
				mode: "single",
				startedAt: Date.now(),
				lastUpdate: Date.now(),
				steps: [{ agent: "test", status: "running" }],
			};
			fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(statusData));

			const status = readStatus(dir);
			assert.ok(status, "should parse status");
			assert.equal(status.runId, "test-123");
			assert.equal(status.state, "running");
			assert.equal(status.mode, "single");
		} finally {
			removeTempDir(dir);
		}
	});

	it("readStatus caches by mtime (second call uses cache)", () => {
		const dir = createTempDir();
		try {
			const statusData = {
				runId: "cache-test",
				state: "running",
				mode: "single",
				startedAt: Date.now(),
			};
			fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(statusData));

			const s1 = readStatus(dir);
			const s2 = readStatus(dir);
			assert.ok(s1);
			assert.ok(s2);
			assert.equal(s1.runId, s2.runId);
		} finally {
			removeTempDir(dir);
		}
	});

	it("readStatus reconciles stale running state when pid is gone", () => {
		const dir = createTempDir();
		try {
			const deadPid = findDeadPid();
			const statusData = {
				runId: "orphaned-run",
				state: "running",
				mode: "single",
				startedAt: Date.now() - 5_000,
				lastUpdate: Date.now() - 5_000,
				pid: deadPid,
			};
			fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(statusData));

			const status = readStatus(dir);
			assert.ok(status);
			assert.equal(status.state, "failed");
			assert.equal(status.orphaned, true);
			assert.match(status.error || "", new RegExp(String(deadPid)));
			assert.ok(status.endedAt, "expected endedAt to be set");

			const persisted = JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf-8"));
			assert.equal(persisted.state, "failed");
			assert.equal(persisted.orphaned, true);
		} finally {
			removeTempDir(dir);
		}
	});

	it("blocks async chain launch when relative reads are not satisfied by earlier outputs", () => {
		const runId = `async-preflight-${Date.now().toString(36)}`;
		const asyncDir = path.join(os.tmpdir(), "pi-async-subagent-runs", runId);
		const tempCwd = createTempDir();
		removeTempDir(asyncDir);
		try {
			const result = executeAsyncChain(runId, {
				chain: [
					{ agent: "pm", task: "Write the brief" },
					{ agent: "planner", task: "Plan the work" },
				],
				agents: [
					makeAgent("pm", { output: "brief.md" }),
					makeAgent("planner", { output: "plan.md", defaultReads: ["context.md"] }),
				],
				ctx: { pi: { events: { emit() {} } }, cwd: tempCwd, currentSessionId: "test-session" },
				config: {},
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 1 },
				shareEnabled: false,
			});

			assert.ok(result.isError, "async chain should fail during preflight");
			assert.match(result.content[0].text, /chain-input-contract-mismatch/);
			assert.equal(result.details.results.length, 0);
			assert.equal(result.details.currentStepIndex, 1);
			assert.equal(fs.existsSync(asyncDir), false, "async run dir should not be created when preflight blocks launch");
		} finally {
			removeTempDir(tempCwd);
		}
	});

	it("blocks async chain launch when two steps claim the same output path", () => {
		const runId = `async-output-collision-${Date.now().toString(36)}`;
		const asyncDir = path.join(os.tmpdir(), "pi-async-subagent-runs", runId);
		const tempCwd = createTempDir();
		removeTempDir(asyncDir);
		try {
			const result = executeAsyncChain(runId, {
				chain: [
					{ agent: "pm", task: "Write the brief" },
					{ agent: "writer", task: "Rewrite the brief" },
				],
				agents: [
					makeAgent("pm", { output: "brief.md" }),
					makeAgent("writer", { output: "brief.md" }),
				],
				ctx: { pi: { events: { emit() {} } }, cwd: tempCwd, currentSessionId: "test-session" },
				config: {},
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 1 },
				shareEnabled: false,
			});

			assert.ok(result.isError, "async chain should fail during preflight");
			assert.match(result.content[0].text, /chain-output-contract-mismatch/);
			assert.equal(result.details.results.length, 0);
			assert.equal(result.details.currentStepIndex, 1);
			assert.equal(fs.existsSync(asyncDir), false, "async run dir should not be created when preflight blocks launch");
		} finally {
			removeTempDir(tempCwd);
		}
	});
});
