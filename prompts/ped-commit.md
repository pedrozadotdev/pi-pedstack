---
description: Create a git commit for the current changes
argument-hint: "[instructions]"
---
Your task is to create a git commit for the current changes in this project using the `git` command line.

Please use your terminal command execution capabilities to analyze the unstaged/staged changes, stage them if necessary, and create the commit.

**Commit Creation Steps:**
1. **Analyze the changes:**
   - Run `git status` to see current modified, added, or deleted files.
   - Run `git diff` and `git diff --staged` to review the exact changes made.
   - Understand the purpose and scope of the work within the current project.

2. **Verify CI Workflows:**
   - Check if the `.github/workflows` folder exists in the project root.
   - If it exists, search for CI workflows or similar files (like tests, linters, or build scripts).
   - Run the same suite of tests or checks locally to ensure the changes don't break the build before committing.

3. **Generate Commit message:**
   Create a concise and descriptive commit message following the Conventional Commits format:
   - **Format:** `type(scope): description`
   - **Types:** feat, fix, docs, refactor, perf, chore, ci, test
   - **Description:** Clear, imperative tone description of the changes (max 50 characters for the summary line).
   - If needed, include a body providing more context about the *why* and *how* of the change.

4. **Stage and Commit:**
   - Stage the relevant files using your terminal tool (e.g., `git add <file>` or `git add .`).
   - Run the commit command with the generated message: `git commit -m "type(scope): description"` or use a temporary file for longer messages (`git commit -F temp.md`).
   
5. **Verify:**
   - Confirm the commit was created successfully from the command output.
   - Output the commit hash and message to the user.

**Important:**
- Ensure you're running these commands within the root directory of the current project.
- Only stage files related to the specific feature or fix you are committing.

**Additional instructions from the user:**
$@