import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Where a skill goes, and the rule that keeps it there.
 *
 * === WHY RESOLUTION RETURNS A LIST OF ONE DIRECTORY PER TARGET ===
 *
 * Codex and Cursor read the same `.agents/skills`, and Cursor ALSO reads
 * `.claude/skills`. Installing for "codex" and then for "cursor" would therefore
 * put one skill in front of Cursor twice, under two paths, and every later
 * `update` would have to reconcile them. Targets are deduplicated by resolved
 * directory, not by agent name.
 *
 * PURE apart from `homedir()`: no filesystem writes, so the resolution can be
 * tested without a temp directory.
 */

export class TargetError extends Error {}

/** Expand `~` and make the path absolute against `cwd`. */
export function expandPath(input, cwd) {
  const expanded = input === "~" || input.startsWith("~/") ? join(homedir(), input.slice(1)) : input;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

/**
 * One resolved skills directory.
 *
 * `base` is what the user's path is checked against: an install may create
 * directories below it and must never write above it.
 */
export function resolveTarget({ agents, agentId, dir, user, cwd }) {
  if (dir) {
    const root = expandPath(dir, cwd);
    return [{ id: "custom", name: "Custom directory", agents: [], root, base: root }];
  }

  const ids = agentId ? [agentId] : agents.map((agent) => agent.id);
  const chosen = [];

  for (const id of ids) {
    const agent = agents.find((entry) => entry.id === id);
    if (!agent) {
      throw new TargetError(
        `unknown agent "${id}". Known: ${agents.map((entry) => entry.id).join(", ")}`,
      );
    }

    const path = user ? agent.userDir : agent.projectDir;
    if (!path) {
      throw new TargetError(`agent "${id}" has no ${user ? "user" : "project"} directory`);
    }

    const root = expandPath(path, cwd);
    const existing = chosen.find((target) => target.root === root);

    if (existing) {
      if (!existing.agents.includes(agent.name)) existing.agents.push(agent.name);
      continue;
    }

    chosen.push({
      id: agent.id,
      name: agent.name,
      agents: [agent.name],
      root,
      // The project root is the directory the path was resolved against, so a
      // write outside it is a bug in this program, not a user choice.
      base: user ? root : cwd,
    });
  }

  return chosen;
}

/**
 * A destination path that is inside `base`.
 *
 * Every path this program writes goes through here. `path.join` alone is not
 * enough: a skill name of `../../etc` joins to a path outside the root and Node
 * happily writes it.
 */
export function safeJoin(base, ...parts) {
  const root = resolve(base);
  const target = resolve(root, ...parts);
  const rel = relative(root, target);

  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new TargetError(`refusing to write outside ${root}: ${target}`);
  }

  // A trailing separator on a nested path is fine; anything else that escaped is not.
  if (rel.split(sep).includes("..")) {
    throw new TargetError(`refusing to write outside ${root}: ${target}`);
  }

  return target;
}
