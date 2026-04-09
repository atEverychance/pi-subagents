Done — cleanup/handoff is complete, and the targeted fatal-path test now passes using built-in Node execution.

### What I changed
- Kept only intended content changes in:
  - `subagent-runner.ts`
  - `subagent-runner-fatal-error.test.ts` (now no `node_modules/.bin/jiti` dependency)
- Reverted accidental edits/files:
  - `package-lock.json`
  - `agents/context-builder.md`
  - `agents/planner.md`
  - `agents/researcher.md`
  - `agents/scout.md`
  - `agents/worker.md`
- Removed accidental artifact:
  - `node_modules/` directory deleted
- Wrote required reporting artifacts:
  - `/Users/jadel.mcguire/.pi/agent/orchestration/runs/cmux-stuck-working-fatal-error-handoff.md`
  - `/Users/jadel.mcguire/.pi/agent/git/github.com/atEverychance/pi-subagents/implementation.md`

### Verification (exactly one targeted test command)
`node --experimental-strip-types --test subagent-runner-fatal-error.test.ts`
- Exit code: `0`
- Output:
  - `▶ subagent-runner fatal errors`
  - `✔ writes failure result payload when runSubagent crashes (156.612833ms)`
  - `✔ subagent-runner fatal errors (157.162917ms)`
  - `ℹ tests 1`
  - `ℹ suites 1`
  - `ℹ pass 1`
  - `ℹ fail 0`
  - `ℹ duration_ms 264.995792`

### Final git status
```text
 M subagent-runner.ts
?? implementation.md
?? subagent-runner-fatal-error.test.ts
```

No commit was made.

TL;DR: Repository is cleaned (no accidental lock/agents/node_modules changes), only intended fix/test files were kept, the fatal-error test now runs via built-in Node with `--experimental-transform-types`+loader, and passes.