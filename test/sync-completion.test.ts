import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { MockPi } from "./helpers.ts";
import { createMockPi, createTempDir, removeTempDir, tryImport } from "./helpers.ts";

interface ExecutorModule {
	createSubagentExecutor?: (...args: unknown[]) => {
		execute: (
			id: string,
			params: Record<string, unknown>,
			signal: AbortSignal,
			onUpdate: ((result: unknown) => void) | undefined,
			ctx: unknown,
		) => Promise<{ isError?: boolean; content: Array<{ text?: string }> }>;
	};
}

interface EmittedEvent {
	type: string;
	payload: any;
}

const executorMod = await tryImport<ExecutorModule>("./subagent-executor.ts");
const available = !!executorMod;
const createSubagentExecutor = executorMod?.createSubagentExecutor;

function makeState(cwd: string) {
	return {
		baseCwd: cwd,
		currentSessionId: null,
		asyncJobs: new Map(),
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: {
			schedule: () => false,
			clear: () => {},
		},
	};
}

describe("sync completion receipts", { skip: !available ? "subagent executor not importable" : undefined }, () => {
	let tempDir: string;
	let mockPi: MockPi;

	before(() => {
		mockPi = createMockPi();
		mockPi.install();
	});

	after(() => {
		mockPi.uninstall();
	});

	beforeEach(() => {
		tempDir = createTempDir("pi-subagent-sync-completion-");
		mockPi.reset();
	});

	afterEach(() => {
		removeTempDir(tempDir);
		const resultsDir = path.join(os.tmpdir(), "pi-async-subagent-results");
		if (fs.existsSync(resultsDir)) {
			for (const file of fs.readdirSync(resultsDir)) {
				if (file.startsWith("sync-") && file.endsWith(".json")) {
					try {
						fs.unlinkSync(path.join(resultsDir, file));
					} catch {}
				}
			}
		}
	});

	function makeExecutor(emitted: EmittedEvent[]) {
		return createSubagentExecutor({
			pi: {
				events: {
					emit: (type: string, payload: any) => {
						emitted.push({ type, payload });
					},
				},
			},
			state: makeState(tempDir),
			config: {},
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (p: string) => p,
			discoverAgents: () => ({
				agents: [
					{ name: "echo", description: "Echo test agent" },
				],
			}),
		});
	}

	function makeCtx(overrides: Record<string, unknown> = {}) {
		return {
			cwd: tempDir,
			hasUI: false,
			ui: {},
			modelRegistry: { getAvailable: () => [] },
			sessionManager: {
				getSessionFile: () => null,
				getLeafId: () => null,
				createBranchedSession: () => "/tmp/unused.jsonl",
			},
			...overrides,
		};
	}

	function completionEvents(emitted: EmittedEvent[]) {
		return emitted.filter((event) => event.type === "subagent:complete").map((event) => event.payload);
	}

	it("writes one sync completion receipt for successful single runs", async () => {
		mockPi.onCall({ output: "done" });
		const emitted: EmittedEvent[] = [];
		const executor = makeExecutor(emitted);

		const result = await executor.execute(
			"id",
			{ agent: "echo", task: "say done" },
			new AbortController().signal,
			undefined,
			makeCtx(),
		);

		assert.equal(result.isError, undefined);
		assert.match(result.content[0]?.text ?? "", /^Subagent echo completed\./);
		const events = completionEvents(emitted);
		assert.equal(events.length, 0);
		const receiptPath = path.join(tempDir, "completion-receipt.json");
		assert.equal(fs.existsSync(receiptPath), true);
		const resultPath = path.join(os.tmpdir(), "pi-async-subagent-results", `sync-id.json`);
		assert.equal(fs.existsSync(resultPath), false);

		const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf-8"));
		assert.equal(receipt.executionMode, "sync");
		assert.equal(receipt.success, true);
		assert.equal(receipt.summary, "done");
		assert.equal(receipt.receiptPath, receiptPath);
	});

	it("marks cancelled clarify flows as cancelled instead of successful", async () => {
		const emitted: EmittedEvent[] = [];
		const executor = makeExecutor(emitted);
		const ctx = makeCtx({
			hasUI: true,
			ui: {
				custom: async () => ({ confirmed: false }),
			},
		});

		const result = await executor.execute(
			"id",
			{ agent: "echo", task: "say done", clarify: true },
			new AbortController().signal,
			undefined,
			ctx,
		);

		assert.equal(result.isError, undefined);
		assert.match(result.content[0]?.text ?? "", /^Subagent echo cancelled\./);
		assert.equal(mockPi.callCount(), 0);

		const events = completionEvents(emitted);
		assert.equal(events.length, 0);
		const receiptPath = path.join(tempDir, "completion-receipt.json");
		assert.equal(fs.existsSync(receiptPath), true);
		const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf-8"));
		assert.equal(receipt.success, false);
		assert.equal(receipt.cancelled, true);
		assert.equal(receipt.exitCode, 130);
		assert.equal(fs.existsSync(path.join(os.tmpdir(), "pi-async-subagent-results", `sync-id.json`)), false);
	});

	it("emits failure completion receipts when sync execution throws", async () => {
		const emitted: EmittedEvent[] = [];
		const executor = makeExecutor(emitted);
		const ctx = makeCtx({
			hasUI: true,
			ui: {
				custom: async () => {
					throw new Error("ui exploded");
				},
			},
		});

		const result = await executor.execute(
			"id",
			{ agent: "echo", task: "say done", clarify: true },
			new AbortController().signal,
			undefined,
			ctx,
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /^Subagent echo failed\./);
		assert.match(result.content[0]?.text ?? "", /ui exploded/);

		const events = completionEvents(emitted);
		assert.equal(events.length, 0);
		const receiptPath = path.join(tempDir, "completion-receipt.json");
		assert.equal(fs.existsSync(receiptPath), true);
		assert.equal(fs.existsSync(path.join(os.tmpdir(), "pi-async-subagent-results", `sync-id.json`)), false);

		const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf-8"));
		assert.equal(receipt.success, false);
		assert.match(receipt.summary, /ui exploded/);
	});
});
