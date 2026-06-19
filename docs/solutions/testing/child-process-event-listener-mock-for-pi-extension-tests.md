---
title: Child Process Event Listener Mock for Pi Extension Timeout Tests
category: testing
severity: medium
tags:
  - pi-extension
  - testing
  - child-process
  - mock
  - multi-reviewer
  - event-listener
  - timeout
  - proc-on
  - pedstack
  - node-child-process
  - mock-pattern
applies_when:
  - Writing tests that mock `node:child_process` for tools that spawn child processes
  - Testing tools that use `proc.on("close", resolve)` patterns
  - Debugging test timeouts in Pi extension test suites
  - The mock's `proc.on` is a no-op and the Promise never settles
  - Writing brittle mocks that need to store event callbacks
---

# Problem

When mocking `node:child_process` in Pi extension tests, a bare `proc.on: () => {}` no-op causes the Promise returned by `runReviewerProcess` (in `multi-reviewer.ts`) to hang indefinitely. The "close" event listener that calls `resolve()` is never stored or invoked, so the test times out.

The naive mock:

```typescript
mock.module("node:child_process", () => {
  return {
    spawn: () => ({
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: () => {},          // ❌ NO-OP — callbacks are discarded
      pid: 123,
    }),
  };
});
```

This pattern silently breaks any code that calls `proc.on("close", cb)` to await process completion.

# Context

During the pi-pedstack ce-core extension's 04-5-debug cycle, 2 tests in `tests/ce-core-extension-runtime.test.ts` consistently timed out with a 5-second default timeout. The tests were for the `multi_reviewer` tool, which uses `runReviewerProcess` from `multi-reviewer.ts`:

```typescript
// multi-reviewer.ts (simplified)
function runReviewerProcess(command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, [], { shell: true });
    proc.on("close", (code) => {  // ← this listener must fire
      if (code === 0) resolve();
      else reject(new Error(`Exit code ${code}`));
    });
    proc.on("error", reject);
  });
}
```

The mock in `ce-core-extension-runtime.test.ts` had `on: () => {}` which silently discarded the "close" callback. The Promise never resolved, and the test timed out.

*Related solution:* [Tool-Based Task Tracking with Handoff Gating](../workflow/tool-based-task-tracking-with-handoff-gating.md) documents the multi_reviewer tool context.

# Solution

## Wire `proc.on` to store callbacks in a listeners dictionary

```typescript
mock.module("node:child_process", () => {
  const listeners: Record<string, Function[]> = {};

  return {
    spawn: () => ({
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: (event: string, cb: Function) => {
        listeners[event] = listeners[event] || [];
        listeners[event].push(cb);
      },
      pid: 123,
    }),
  };
});
```

Then, in the test body, invoke the stored callback to simulate process completion:

```typescript
it("resolves when process exits with code 0", async () => {
  // ... invoke the tool ...
  const closeCallbacks = listeners["close"];
  closeCallbacks?.[0]?.(0);  // simulate exit code 0
  // ... assert resolution ...
});
```

## Key invariants

1. **`proc.on` must be a real function that stores callbacks** — never a no-op
2. **The listeners dictionary must be scoped to share between mock setup and test body** — declare it at the module level, not inside `spawn()`
3. **"close" and "error" events both need storage** — `runReviewerProcess` listens for both
4. **The mock must match the real API contract**: `proc.on(event, cb)` where `cb` is `(code: number | null) => void` for "close" and `(err: Error) => void` for "error"

## Complete working pattern

```typescript
import { mock } from "bun:test";

// Step 1: Declare listeners at module scope
const listeners: Record<string, Function[]> = {};

// Step 2: Mock with storage, not no-op
mock.module("node:child_process", () => {
  const fakeProcess = {
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    on: (event: string, cb: Function) => {
      (listeners[event] ??= []).push(cb);
    },
    pid: 123,
    kill: () => {},
  };

  return { spawn: () => fakeProcess };
});

// Step 3: In test body, fire the event
describe("multi_reviewer", () => {
  it("handles process completion", async () => {
    const promise = runReviewerProcess(); // hypothetical

    // Fire the "close" event as the real process would
    const closeCb = listeners["close"]?.[0];
    if (closeCb) closeCb(0);

    await promise; // now resolves instead of timing out
  });
});
```

# Why this works

1. **Event-driven resolution**: `runReviewerProcess` uses a `new Promise` with `resolve` wired to `proc.on("close", ...)`. The only way the Promise settles is if "close" fires. A no-op mock starves the Promise forever.
2. **Test control**: By storing callbacks in a module-scoped dictionary, the test gains explicit control over when and how the simulated process completes. This is more predictable than trying to run real child processes in tests.
3. **Defensive by default**: The mock isn't just "less wrong" — it's correct. It matches the real `ChildProcess.on` behavior of supporting multiple listeners per event.

# Prevention

- **Audit mocks for discarded callbacks**: Any mock with `on: () => {}` should be suspect. If the real code registers event listeners, the mock must store them.
- **Use the listeners dictionary pattern as a default**: When mocking `node:child_process`, always use the event-storage pattern, not a no-op. It's more work upfront but prevents subtle timeout bugs.
- **Add a timeout guard in tests**: If the invariant is important, set a short test timeout (e.g., 1000ms) so the test fails fast instead of hanging for the default timeout.
- **Review paired patterns**: If any test file mocks `node:child_process`, check for companion tests firing the stored events. A mock with stored listeners but no test that fires them is dead code.

## Downstream Impact

### For 02-plan

When planning tests for tools that spawn child processes:

- Plan the event-storage mock pattern from the start — don't start with a no-op and fix later
- Plan for both "close" and "error" event paths in tests
- Add a timeout guard (e.g., `{ timeout: 1000 }` in Bun's `it()`) to fail fast if the mock is wrong

### For 04-review

When reviewing test mocks for `node:child_process`:

- **BLOCK** any `proc.on` that is a no-op `() => {}` if the code under test uses `proc.on("close", ...)` for Promise resolution
- Verify the listeners dictionary is at module scope (shared between mock and test body), not captured inside `spawn()`
- Verify tests fire both the success path (close with code 0) and the error path (close with non-zero, error event)

## Provenance

- **Source review:** `docs/reviews/2026-06-19-checklist-tools.md` (multi_reviewer timeout tests)
- **Source debug session:** `.context/compound-engineering/handoffs/2026-06-19T15-34-05-875Z-04-5-debug-to-05-learn.md`
- **Source files:**
  - `tests/ce-core-extension-runtime.test.ts` — Event-storage mock + close event firing
  - `extensions/ce-core/tools/multi-reviewer.ts` — `runReviewerProcess` that consumes the events
  - `tests/ce-core-extension-tools.test.ts` — Reference implementation of the same pattern
