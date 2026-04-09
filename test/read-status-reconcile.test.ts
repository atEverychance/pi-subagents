import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readStatus } from "../utils.ts";

function createTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-status-test-"));
}

function removeTempDir(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

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

describe("readStatus reconciliation", () => {
	it("marks queued/running runs failed when recorded pid no longer exists", () => {
		const dir = createTempDir();
		try {
			const deadPid = findDeadPid();
			fs.writeFileSync(
				path.join(dir, "status.json"),
				JSON.stringify({
					runId: "run-dead-pid",
					mode: "single",
					state: "running",
					startedAt: Date.now() - 2_000,
					lastUpdate: Date.now() - 2_000,
					pid: deadPid,
				}),
			);

			const status = readStatus(dir);
			assert.ok(status);
			assert.equal(status.state, "failed");
			assert.equal(status.orphaned, true);
			assert.match(status.error ?? "", new RegExp(String(deadPid)));
			assert.ok(status.endedAt);

			const persisted = JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf-8"));
			assert.equal(persisted.state, "failed");
			assert.equal(persisted.orphaned, true);
		} finally {
			removeTempDir(dir);
		}
	});
});
