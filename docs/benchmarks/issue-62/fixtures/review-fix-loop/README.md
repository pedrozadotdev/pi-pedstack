# Review-fix-loop fixture

Task: add percentage discounts with validation and focused tests. The seeded
implementation fails to clamp percentages above 100; the review is expected to
report this concrete boundary defect, work must fix it, and re-review must be
clean. Acceptance: amounts are integer cents, percentage is in `[0, 100]`, and
the returned price never goes below zero. Run the focused fixture check with
`bun test tests/discount.fixture.ts`.
