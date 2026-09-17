# Subagent Reports

This directory stores concise, non-sensitive reports from delegated research
and implementation work.

Each report should include:

- Task objective and scope
- Agent type or task ID when available
- Files inspected or changed
- Verified findings
- Assumptions and unresolved risks
- Tests or commands run
- Integration recommendation

Do not store credentials, full confidential documents, model prompts containing
company data, or raw tool outputs that may contain sensitive information.

The orchestrating agent reviews every delegated diff, resolves overlaps, runs
package-level verification, updates `learning.md` and `CONTEXT.md`, and owns
commits.
