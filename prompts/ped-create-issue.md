---
description: Create a detailed GitHub issue from user requirements
argument-hint: "[requirements]"
---
Your task is to create a detailed GitHub issue for this project using the GitHub CLI (`gh`).

The user will provide their requirements as arguments. Your job is to analyze the project, understand the context, and craft a well-structured issue that is actionable and clear for developers.

**Issue Creation Steps:**
1. **Analyze the project and requirements:**
   - Run `git status` and review the project structure to understand the codebase.
   - Review relevant source files, documentation, or existing issues (`gh issue list`) to understand the current state and avoid duplicates.
   - Carefully parse the user's requirements to identify the core ask, scope, and any implicit constraints.

2. **Generate the issue content:**
   Create a comprehensive issue with the following structure:
   - **Title:** A concise, descriptive title that clearly conveys the issue's purpose. Use a conventional prefix when appropriate (e.g., `feat:`, `fix:`, `docs:`, `refactor:`, `perf:`, `chore:`). Keep it under 72 characters.
   - **Description:** A clear, high-level summary of what is being requested and why.
   - **Motivation / Context:** Explain *why* this issue matters — the problem it solves, the user need it addresses, or the improvement it brings.
   - **Requirements:** A detailed, actionable checklist (`- [ ]`) of the specific requirements or acceptance criteria derived from the user's input.
   - **Technical Notes:** Any relevant implementation details, architectural considerations, affected files/modules, or suggested approaches. Reference specific files or code paths when possible.
   - **Additional Context:** Any related issues, dependencies, screenshots, logs, or references that provide useful context.

3. **Create the issue:**
   - Use the `gh issue create` command via your terminal tool.
   - Pass the generated title and body (e.g., `gh issue create --title "..." --body "..."`), or use a temporary file for the body if it's very long (`gh issue create --title "..." --body-file temp.md`).
   - Apply appropriate labels if they exist in the repository (check with `gh label list`). Common labels: `enhancement`, `bug`, `documentation`, `refactor`, `good first issue`.
   - Assign a milestone if one is relevant and available (`gh issue create --milestone "..."`).

4. **Verify:**
   - Confirm the issue was created successfully from the command output.
   - Output the issue URL to the user.
   - Summarize the issue details (title, labels, and a brief overview of the requirements).

**Important:**
- Ensure you're running these commands within the root directory of the current project.
- Do not create duplicate issues — check existing open issues first.
- Write the issue body in a way that is self-contained: a developer reading it should understand the full scope without needing external context.
- If the requirements are vague or ambiguous, do NOT make silent assumptions. Instead, ask the user to clarify before creating the issue. Present specific options and your recommended choice to help them decide quickly.

**User requirements:**
$@

If the user's requirements reference existing issues, PRs, or branches, ensure they are cross-linked in the issue body.