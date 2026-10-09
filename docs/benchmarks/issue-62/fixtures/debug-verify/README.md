# Debug-and-verify fixture

Task: use `/ped-debug` with the required prompt to reproduce and fix the seeded
rectangle area defect. Run `bun test tests/area.fixture.ts` and
`bun x tsc --noEmit`, record the failing case before the fix and passing results
after it, then save the handoff to `03-work` and complete review. The defect is
`area()` returning `width + height` instead of `width * height`.
