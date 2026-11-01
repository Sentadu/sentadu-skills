# @sentadu/skills

Agent skills for the [Sentadu](https://sentadu.com) eSIM API. Install them once and your coding
agent knows the endpoints, the auth scheme, the Rupiah rules and the webhook contract before it
writes the first line of an integration.

Without a skill, an agent reconstructs an API from a docs page it half read, and the mistakes it
makes are the expensive kind: a currency conversion that should never happen, a retry that places
a second order, a webhook signature verified against a re-serialised body.

## Install

```sh
npx @sentadu/skills init
```

That writes all three skills into the directory your agent reads and stops. Preview it first with
`--dry-run`, or narrow it to one agent:

```sh
npx @sentadu/skills init --dry-run
npx @sentadu/skills init --agent claude-code
npx @sentadu/skills install sentadu-api --agent codex
npx @sentadu/skills init --user          # your home directory, not this project
npx @sentadu/skills init --dir ./vendor/skills
```

`init` installs everything. `install` takes names. Both write the same files to the same places.

## The skills

| Skill | Answers |
| --- | --- |
| `sentadu-api` | Which endpoints exist, how auth works, what every error code means, how the sandbox differs from live |
| `sentadu-webhooks` | The four order events, signature verification over the raw body, the retry ladder, deduplication |
| `sentadu-security` | Key shape and storage, what must never be logged, why a 404 is not a 403, the things never to disable |

Each one is a `SKILL.md` plus a `references/` directory. The agent loads `SKILL.md` when the skill
triggers and opens a reference only for the part it is working on.

## Where it installs

| Agent | Project | With `--user` |
| --- | --- | --- |
| Claude Code | `.claude/skills/` | `~/.claude/skills/` |
| Codex | `.agents/skills/` | `~/.agents/skills/` |
| Cursor | `.agents/skills/` | `~/.agents/skills/` |
| Anything else | `--dir <path>` | `--dir <path>` |

Each path comes from that agent's own documentation, linked in `adapters/agents.json` so the next
person can re-check it. Codex and Cursor read the same `.agents/skills`, so an install for one is
an install for both; Cursor additionally reads `.claude/skills`, which is why a codex + claude-code
pair means two copies on disk and no more.

Anything the installer writes is plain files. Commit them, and everyone who clones the repository
gets the same skills.

## Keeping them current

```sh
npx @sentadu/skills update --dry-run
npx @sentadu/skills update
```

`update` reads the manifest the installer left in the skills directory and rewrites only the files
that still match it. **A file you edited is never touched.** It is reported and the command exits
`4`, so a CI job notices instead of shipping a stale copy on top of your changes.

To take the update anyway, delete the file first, or install into a fresh directory.

## Commands

```
sentadu-skills list [--json]
sentadu-skills install <skill>... [--agent <id>] [--dir <path>] [--user]
                                  [--dry-run] [--force] [--json]
sentadu-skills init   [--agent <id>] [--dir <path>] [--user] [--dry-run] [--force] [--json]
sentadu-skills update [--dir <path>] [--dry-run] [--json]
sentadu-skills doctor [--dir <path>] [--json]
```

`doctor` checks both sides: that the bundled skills are valid, and that the copy in this directory
is complete.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Done |
| `1` | Something failed |
| `2` | Bad usage |
| `3` | Files exist and `--force` was not given |
| `4` | `update` skipped files you edited |
| `5` | No usable target directory |

## What it will not do

- **No network access.** Every byte comes from the package you installed. An installer that
  fetches a "latest" copy at run time is a remote-code path into your repository.
- **No dependencies.** Five modules, `node:` built-ins only, no install scripts, nothing to audit.
- **No silent overwrite.** A file that exists and was not written by this installer is a conflict
  (`3`), with the paths listed.
- **No writes outside the tree.** Every destination is resolved and checked against the skills
  root, and a symlink is refused rather than followed.
- **No deletes.** `update` removes nothing, ever, including files that a release stopped shipping.

## Requirements

Node.js 20 or later. No other runtime.

## Compatibility, stated honestly

The three agents above were checked against their own documentation on 2026-11-01. The CLI and
installer are tested on Linux; the Windows and macOS code paths use `path.join` throughout and no
hardcoded separators, but they are **not tested on real machines**. If you hit a platform problem,
please open an issue with the OS and the command.

Other agents that read the [Agent Skills](https://skillpm.dev/creating-skills/) layout work through
`--dir`.

## The same content on the website

`sentadu-api` is also downloadable from [sentadu.com/id/docs/skills](https://sentadu.com/id/docs/skills)
as a `.zip` or `.tar.gz`. That copy and the one in this package are the same files; this package
adds the installer, the manifest, and the other two skills.

## Licence

MIT. See `LICENSE`. The Sentadu API is a commercial service under its own terms.
