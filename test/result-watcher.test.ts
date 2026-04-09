import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createResultWatcher } from "../result-watcher.ts";

function makeTempDir(prefix = "pi-subagent-result-watcher-") {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("result watcher", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (dir) fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("ignores and cleans stale sync result files", async () => {
		const resultsDir = makeTempDir();
		tempDirs.push(resultsDir);
		const emitted: Array<{ type: string; payload: unknown }> = [];
		const state: any = {
			currentSessionId: "session-1",
			baseCwd: "/tmp/project",
			completionSeen: new Map(),
			watcher: null,
			watcherRestartTimer: null,
			resultFileCoalescer: { schedule: () => false, clear: () => {} },
		};
		const pi: any = {
			events: {
				emit: (type: string, payload: unknown) => emitted.push({ type, payload }),
			},
		};
		fs.writeFileSync(
			path.join(resultsDir, "sync-stale.json"),
			JSON.stringify({ id: "sync-stale", executionMode: "sync", sessionId: "session-1" }),
			"utf-8",
		);
		fs.writeFileSync(
			path.join(resultsDir, "async-fresh.json"),
			JSON.stringify({ id: "async-fresh", executionMode: "async", sessionId: "session-1" }),
			"utf-8",
		);

		const watcher = createResultWatcher(pi, state, resultsDir, 10 * 60 * 1000);
		watcher.primeExistingResults();
		await new Promise((resolve) => setTimeout(resolve, 20));
		watcher.stopResultWatcher();

		assert.equal(fs.existsSync(path.join(resultsDir, "sync-stale.json")), false);
		assert.equal(fs.existsSync(path.join(resultsDir, "async-fresh.json")), false);
		assert.deepEqual(emitted.map((entry) => entry.type), ["subagent:complete"]);
		assert.equal((emitted[0]?.payload as any)?.id, "async-fresh");
	});
});
