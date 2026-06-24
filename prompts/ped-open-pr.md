---
description: Create and open a Pull Request for the current branch
argument-hint: "[issue] [instructions]"
---
Your task is to create and open a Pull Request for the current branch in this project using the GitHub CLI (`gh`). 

Please use your terminal command execution capabilities to analyze the changes, push the branch, and create the PR.

**PR Creation Steps:**
1. **Analyze the branch and project:**
   - Run `git status` to ensure you are on the correct branch and there are no uncommitted changes.
   - Run `git log origin/main..HEAD` or `git diff main...HEAD` to review all commits and changes on this branch.
   - Understand the purpose and scope of the work within the current project.

2. **Generate PR description:**
   Create a comprehensive PR description that includes:
   - **Title:** Conventional Commit summary (`type: description` or `type(scope): description`), 50-72 characters. Types: feat, fix, docs, refactor, perf, chore, ci, test
   - **Overview:** Brief description of what this PR does
   - **Changes:** Detailed list of changes made
   - **Motivation:** Why these changes are needed
   - **Testing:** How the changes were tested
   - **Screenshots/Examples:** If applicable (for UI changes)
   - **Breaking Changes:** Any breaking changes (if applicable)
   - **Related Issues:** Link to related issues (e.g., "Closes #123"). If an issue number was provided in the arguments, ensure it is referenced here.

3. **Push Branch and Create the PR:**
   - Push the current branch to the remote repository: `git push -u origin HEAD`
   - Use the `gh pr create` command via your terminal tool to create the PR for the current project.
   - Pass the generated title and body (e.g., `gh pr create --title "..." --body "..."`) or use a temporary file for the body if it's very long (`gh pr create --title "..." --body-file temp.md`).
   - Set appropriate labels or request reviewers if needed, using the respective `gh pr create` flags.

4. **Verify:**
   - Confirm the PR was created successfully from the command output.
   - Output the PR URL to the user.
   - Summarize the PR details.

**Important:**
- Ensure you're running these commands within the root directory of the current project.
- Verify the base branch is correct (usually `main` or `develop`).

**Additional instructions from the user (may include a target issue number):**
$@

If an issue number was provided in the arguments above, ensure you reference it in the PR description.