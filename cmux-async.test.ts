import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildHostedCommand, clipTitle, closeCmuxHost, getCmuxAsyncConfig } from "./cmux-async.ts";

describe("clipTitle", () => {
	it("truncates long titles safely", () => {
		const clipped = clipTitle("π subagent " + "x".repeat(200), 20);
		assert.equal(clipped.endsWith("…"), true);
		assert.equal(clipped.length <= 20, true);
	});
});

describe("getCmuxAsyncConfig", () => {
	it("prefers env overrides over config", () => {
		const cfg = getCmuxAsyncConfig(
			{ cmuxAsyncHost: "off", cmuxSplitDirection: "left", cmuxKeepShellOpen: false, cmuxBin: "cmux-a" },
			{
				PI_SUBAGENTS_CMUX_ASYNC: "workspace",
				PI_SUBAGENTS_CMUX_SPLIT_DIRECTION: "down",
				PI_SUBAGENTS_CMUX_KEEP_SHELL_OPEN: "1",
				PI_SUBAGENTS_CMUX_BIN: "cmux-b",
			} as NodeJS.ProcessEnv,
		);
		assert.equal(cfg.mode, "workspace");
		assert.equal(cfg.splitDirection, "down");
		assert.equal(cfg.keepShellOpen, true);
		assert.equal(cfg.bin, "cmux-b");
	});
});

describe("buildHostedCommand", () => {
	it("wraps a runner command and keeps shell open when requested", () => {
		const command = buildHostedCommand("node /tmp/runner.js", "π subagent · scout", "split", true);
		assert.match(command, /bash -lc/);
		assert.match(command, /tab-action --action rename/);
		assert.match(command, /exec \$SHELL -l/);
	});
});

describe("closeCmuxHost", () => {
	it("treats missing split surface as already closed", () => {
		const result = closeCmuxHost(
			{ mode: "split", title: "run", surfaceRef: "surface:42" },
			"cmux",
			() => ({ ok: false, stdout: "", stderr: "surface not found" }),
		);
		assert.equal(result.state, "already_closed");
	});

	it("marks split host closed when close command succeeds", () => {
		const result = closeCmuxHost(
			{ mode: "split", title: "run", surfaceRef: "surface:42" },
			"cmux",
			() => ({ ok: true, stdout: "", stderr: "" }),
		);
		assert.equal(result.state, "closed");
	});

	it("treats missing workspace as already closed even when close command is unsupported", () => {
		let calls = 0;
		const result = closeCmuxHost(
			{ mode: "workspace", title: "run", workspaceId: "123" },
			"cmux",
			(_bin, args) => {
				calls++;
				if (args[0] === "workspace-action") return { ok: false, stdout: "", stderr: "unknown command workspace-action" };
				if (args[0] === "close-workspace") return { ok: false, stdout: "", stderr: "unknown command close-workspace" };
				return { ok: false, stdout: "", stderr: "workspace does not exist" };
			},
		);
		assert.equal(result.state, "already_closed");
		assert.equal(calls >= 3, true);
	});
});
