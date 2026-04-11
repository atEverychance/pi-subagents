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

function findCompletionReceiptPath(rootDir: string): string | null {
	const stack = [rootDir];
	while (stack.length > 0) {
		const current = stack.pop()!;
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const entryPath = path.join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(entryPath);
				continue;
			}
			if (entry.isFile() && entry.name === "completion-receipt.json") {
				return entryPath;
			}
		}
	}
	return null;
}

function loadCompletionReceipt(rootDir: string): { receiptPath: string; receipt: any } {
	const receiptPath = findCompletionReceiptPath(rootDir);
	assert.ok(receiptPath, "Expected sync completion-receipt.json to be written");
	const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf-8"));
	return { receiptPath, receipt };
}

describe("sync completion receipts", { skip: !available ? "subagent executor not importable" : undefined }, () => {
	let tempDir: string;
	let mockPi: MockPi;
	let savedSubagentDepth: string | undefined;
	let savedSubagentMaxDepth: string | undefined;

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
		savedSubagentDepth = process.env.PI_SUBAGENT_DEPTH;
		savedSubagentMaxDepth = process.env.PI_SUBAGENT_MAX_DEPTH;
		process.env.PI_SUBAGENT_DEPTH = "0";
		delete process.env.PI_SUBAGENT_MAX_DEPTH;
	});

	afterEach(() => {
		removeTempDir(tempDir);
		if (savedSubagentDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
		else process.env.PI_SUBAGENT_DEPTH = savedSubagentDepth;
		if (savedSubagentMaxDepth === undefined) delete process.env.PI_SUBAGENT_MAX_DEPTH;
		else process.env.PI_SUBAGENT_MAX_DEPTH = savedSubagentMaxDepth;
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

	it("writes one sync completion receipt and emits canonical completion for successful single runs", async () => {
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
		assert.equal(events.length, 1);
		assert.equal(events[0]?.executionMode, "sync");
		assert.equal(events[0]?.success, true);
		assert.equal(events[0]?.summary, "done");
		assert.match(events[0]?.id ?? "", /^sync-/);

		const resultPath = path.join(os.tmpdir(), "pi-async-subagent-results", "sync-id.json");
		assert.equal(fs.existsSync(resultPath), false);

		const { receiptPath, receipt } = loadCompletionReceipt(tempDir);
		assert.equal(receipt.executionMode, "sync");
		assert.equal(receipt.success, true);
		assert.equal(receipt.summary, "done");
		assert.equal(receipt.receiptPath, receiptPath);
		assert.equal(events[0]?.receiptPath, receiptPath);
	});

	it("marks provider-surfaced assistant errors as failed in sync completion receipts", async () => {
		mockPi.onCall({
			jsonl: [
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Provider failure" }],
						errorMessage: "Provider overloaded",
						model: "mock/test-model",
						usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
					},
				},
			],
		});
		const emitted: EmittedEvent[] = [];
		const executor = makeExecutor(emitted);

		const result = await executor.execute(
			"id",
			{ agent: "echo", task: "say done" },
			new AbortController().signal,
			undefined,
			makeCtx(),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Provider overloaded/);
		const events = completionEvents(emitted);
		assert.equal(events.length, 1);
		assert.equal(events[0]?.success, false);
		assert.equal(events[0]?.exitCode, 1);
		assert.match(events[0]?.summary ?? "", /Provider overloaded/);

		const { receiptPath, receipt } = loadCompletionReceipt(tempDir);
		assert.equal(receipt.success, false);
		assert.equal(receipt.exitCode, 1);
		assert.match(receipt.summary, /Provider overloaded/);
		assert.equal(events[0]?.receiptPath, receiptPath);
	});

	it("marks cancelled clarify flows as cancelled and emits canonical sync completion", async () => {
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
		assert.equal(result.content[0]?.text ?? "", "Cancelled");
		assert.equal(mockPi.callCount(), 0);

		const events = completionEvents(emitted);
		assert.equal(events.length, 1);
		assert.equal(events[0]?.executionMode, "sync");
		assert.equal(events[0]?.success, false);
		assert.equal(events[0]?.cancelled, true);
		assert.equal(events[0]?.exitCode, 130);
		assert.equal(events[0]?.summary, "Cancelled");
		assert.match(events[0]?.id ?? "", /^sync-/);

		assert.equal(fs.existsSync(path.join(os.tmpdir(), "pi-async-subagent-results", "sync-id.json")), false);
		const { receiptPath, receipt } = loadCompletionReceipt(tempDir);
		assert.equal(receipt.success, false);
		assert.equal(receipt.cancelled, true);
		assert.equal(receipt.exitCode, 130);
		assert.equal(events[0]?.receiptPath, receiptPath);
	});

	it("emits canonical failure completion receipts when sync execution throws", async () => {
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
		assert.equal(result.content[0]?.text ?? "", "ui exploded");

		const events = completionEvents(emitted);
		assert.equal(events.length, 1);
		assert.equal(events[0]?.executionMode, "sync");
		assert.equal(events[0]?.success, false);
		assert.equal(events[0]?.exitCode, 1);
		assert.match(events[0]?.summary ?? "", /ui exploded/);
		assert.match(events[0]?.id ?? "", /^sync-/);

		assert.equal(fs.existsSync(path.join(os.tmpdir(), "pi-async-subagent-results", "sync-id.json")), false);
		const { receiptPath, receipt } = loadCompletionReceipt(tempDir);
		assert.equal(receipt.success, false);
		assert.match(receipt.summary, /ui exploded/);
		assert.equal(events[0]?.receiptPath, receiptPath);
	});
});
