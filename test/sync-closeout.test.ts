import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCompactSyncCloseout } from "../sync-closeout.ts";

describe("buildCompactSyncCloseout", () => {
	it("builds a compact summary with preview and artifact paths", () => {
		const text = buildCompactSyncCloseout({
			agent: "writer",
			success: true,
			outputText: "PM readiness score: 3/10\nMore detail below",
			sessionFile: "/tmp/child.jsonl",
			receiptPath: "/tmp/receipt.json",
		});

		assert.match(text, /^Subagent writer completed\./);
		assert.match(text, /Preview: PM readiness score: 3\/10/);
		assert.match(text, /Session: \/tmp\/child\.jsonl/);
		assert.match(text, /Receipt: \/tmp\/receipt\.json/);
		assert.match(text, /intentionally compact for reliability/);
	});

	it("prefers error text for failed runs", () => {
		const text = buildCompactSyncCloseout({
			agent: "writer",
			success: false,
			errorText: "Validation failed: missing file",
		});

		assert.match(text, /^Subagent writer failed\./);
		assert.match(text, /Preview: Validation failed: missing file/);
	});
});
