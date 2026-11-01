# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning is
[Semantic Versioning](https://semver.org/spec/v2.0.0.html), applied to the skills and the CLI
together:

- **Major** — a skill is removed or renamed, the CLI's flags or exit codes change incompatibly,
  or an installed file moves.
- **Minor** — a skill is added, a new command or flag appears, a reference grows a section.
- **Patch** — wording, corrections, and anything that does not change what an installer writes
  or where.

## 1.0.0 — 2026-11-01

First release.

- Three skills: `sentadu-api`, `sentadu-webhooks`, `sentadu-security`.
- `sentadu-skills` CLI: `list`, `install`, `init`, `update`, `doctor`.
- Installs into `.claude/skills` (Claude Code) and `.agents/skills` (Codex, Cursor), with a
  manifest so `update` can tell an old copy from a file the user edited.
- No dependencies, no install scripts, no network access.
