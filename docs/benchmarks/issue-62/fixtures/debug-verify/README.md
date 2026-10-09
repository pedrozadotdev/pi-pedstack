# Debug-and-verify fixture

First add a short API description to this fixture's `README.md` with
`/ped-start`, carry that documentation-only change through a clean `04-review`,
and invoke `/ped-debug` before accepting the pending `05-learn` transition.
Then reproduce and fix the seeded rectangle-area defect. Run
`bun test tests/area.fixture.ts` and `bun x tsc --noEmit`, record the failing
case before the fix and passing results after it, then save the handoff to
`05-learn`. The defect is `area()` returning `width + height` instead of
`width * height`.
