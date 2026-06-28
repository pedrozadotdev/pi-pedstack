---
name: 04-5-debug
description: "Debug and fix issues with a 5-phase workflow: Information Gathering, Root Cause Analysis, Implementation, Verification, Report."
disable-model-invocation: true
---

# Debug and Fix

Your goal is to find the root cause of a bug and fix it. You are stepping into an active investigation context where something is broken.

## 1. Information Gathering

Before making any code changes, completely understand the state of the problem:

- Check logs, test outputs, or error traces. Use tools to reproduce the error if necessary.
- If the issue refers to a specific file or URL, read the source to understand the context.
- Identify what the expected behavior is vs. the actual broken behavior.

## 2. Root Cause Analysis

Do not guess. Use a systematic approach to isolate the cause:

- **Trace the execution:** Follow the data or logic flow backwards from the error output.
- **Hypothesize and Test:** Formulate a clear hypothesis of why the bug occurs. Use tools (like `grep` or file reads) to confirm the hypothesis in the codebase before changing logic.
- Avoid treating symptoms. Make sure your fix addresses the underlying structural issue.

## 3. Implementation

Once you have confirmed the root cause:

- Implement the simplest, most robust fix.
- Ensure the fix doesn't introduce side effects or break existing patterns.
- Follow the project's coding style and conventions.

## 4. Verification

- After applying the fix, verify that the bug is resolved.
- If it was a failing test, run the test again. If it was a runtime error, verify the logs no longer produce the error.
- If the fix fails, rollback your assumptions and start the diagnosis loop again.

## 5. Report

Once the bug is fixed and verified, provide a concise summary to the user detailing:

1. The root cause of the bug.
2. The exact files and logic changed to fix it.
3. How it was verified.

## Additional Rules

- After completing the report, save a context handoff targeting 05-learn.
- Follow Ponytail discipline: fix the root cause, not the symptom. Don't scope creep.
