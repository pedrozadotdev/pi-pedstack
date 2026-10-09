# Catalog requirements

Build a TypeScript catalog package with these independently verifiable units:

1. Parse a line-oriented catalog format into typed records.
2. Validate unique ids, non-empty names, and non-negative integer prices.
3. Search case-insensitively by name and return stable input order.
4. Render a compact Markdown catalog with escaped pipe characters.
5. Add unit tests for valid input, every validation error, search ordering, and
   Markdown escaping.
6. Document the format and verification command in README.md.

Keep each unit independently testable and preserve the acceptance behavior
above. Do not add dependencies.
