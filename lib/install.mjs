import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { classify, readManifest, recordSkill, writeManifest } from "./manifest.mjs";
import { readSkill } from "./skills.mjs";
import { safeJoin, TargetError } from "./targets.mjs";

/**
 * Writing skills to a directory, and the three ways it can refuse.
 *
 * === NOTHING HERE TOUCHES THE NETWORK ===
 *
 * Every byte comes from the package the CLI was installed from. An installer that
 * fetches a "latest" copy at run time would be a remote-code path into the user's
 * repository, so it does none of that.
 */

export class InstallError extends Error {
  constructor(message, code, detail) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

/** Read a destination file, or null when it does not exist. Refuses symlinks. */
function readExisting(skillName, root) {
  return (relativePath) => {
    const full = safeJoin(root, skillName, relativePath);

    let stat;
    try {
      stat = lstatSync(full);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }

    // A symlink is someone else's content, or a deliberate trap. Either way this
    // installer does not write through it: following one would put our bytes
    // wherever it points, which may be outside the tree entirely.
    if (stat.isSymbolicLink()) {
      throw new InstallError(
        `${skillName}/${relativePath} is a symlink; refusing to write through it`,
        "SYMLINK",
        relativePath,
      );
    }

    if (!stat.isFile()) {
      throw new InstallError(
        `${skillName}/${relativePath} is not a regular file`,
        "NOT_A_FILE",
        relativePath,
      );
    }

    return readFileSync(full, "utf8");
  };
}

function writeSkillFile(root, skillName, file) {
  const full = safeJoin(root, skillName, file.path);

  /**
   * THE SYMLINK CHECK RUNS HERE, NOT ONLY IN THE PLAN.
   *
   * `--force` skips planning (every file is written unconditionally), so a plan
   * time check never runs in exactly the mode a user reaches for when an install
   * is misbehaving. `mkdirSync(recursive)` happily accepts a symlinked directory
   * and `writeFileSync` then writes through it, outside the tree. Checking at the
   * last moment before the write is the one place that cannot be skipped.
   */
  const parent = dirname(full);
  let existingParent = parent;
  while (!existsSync(existingParent)) {
    existingParent = dirname(existingParent);
  }
  if (lstatSync(existingParent).isSymbolicLink()) {
    throw new InstallError(
      `${skillName}/${file.path} would be written through a symlinked directory`,
      "SYMLINK",
      file.path,
    );
  }

  mkdirSync(parent, { recursive: true });
  writeFileSync(full, file.content, "utf8");
  if (file.executable) {
    // Only where the platform has the concept. On Windows the mode is a no-op,
    // and git records the bit separately for anyone who clones the tree.
    try {
      chmodSync(full, 0o755);
    } catch {
      /* not POSIX */
    }
  }
}

/**
 * Plan an install without writing anything.
 *
 * Split out because `--dry-run` and the real thing must agree. A dry run that
 * computed its own answer would be a second implementation, and the day they
 * disagreed the dry run would be the one people trusted.
 */
export function planInstall({ root, skillNames, force }) {
  const manifest = readManifest(root);
  const plan = [];

  for (const name of skillNames) {
    const skill = readSkill(name);

    if (force) {
      plan.push({ skill, create: skill.files, write: [], skipEdited: [] });
      continue;
    }

    const { create, write, skipEdited } = classify(
      skill,
      manifest,
      readExisting(skill.name, root),
    );

    plan.push({ skill, create, write, skipEdited });
  }

  return { root, manifest, plan };
}

/**
 * Anything that exists on disk and would be replaced.
 *
 * A skill folder already in the tree that this manifest does not own is a
 * conflict even when its contents happen to match, because the next `update`
 * cannot tell whose copy it is.
 */
export function conflictsOf({ plan }) {
  const conflicts = [];
  for (const entry of plan) {
    for (const file of entry.skipEdited) {
      conflicts.push({ skill: entry.skill.name, path: file.path });
    }
  }
  return conflicts;
}

export function applyInstall({ root, manifest, plan, update = false }) {
  const written = [];
  const skipped = [];

  for (const entry of plan) {
    for (const file of entry.skipEdited) {
      skipped.push({ skill: entry.skill.name, path: file.path });
    }
  }

  // Refuse before writing a single byte: a half-applied install is worse than a
  // refusal, because the tree then disagrees with the manifest.
  if (skipped.length > 0 && !update) {
    throw new InstallError(
      `${skipped.length} file(s) already exist and were not written by this installer`,
      "CONFLICT",
      skipped,
    );
  }

  // Nothing to do means nothing to create: `update` in a directory with no
  // install must not leave an empty skills root and a manifest behind.
  const work = plan.filter((entry) => entry.create.length + entry.write.length > 0);
  if (work.length === 0) return { written, skipped };

  mkdirSync(root, { recursive: true });

  let next = manifest;

  for (const entry of work) {
    for (const file of [...entry.create, ...entry.write]) {
      writeSkillFile(root, entry.skill.name, file);
      written.push({ skill: entry.skill.name, path: file.path });
    }
    next = recordSkill(next, entry.skill);
  }

  writeManifest(root, next);

  return { written, skipped };
}

/**
 * `update`: refresh every owned skill, and report what it declined to touch.
 *
 * A file whose bytes no longer match the manifest is the user's. It is skipped,
 * never overwritten and never deleted, and the command exits non-zero so a CI job
 * notices instead of silently shipping a stale copy.
 */
export function planUpdate({ root }) {
  const manifest = readManifest(root);
  const names = Object.keys(manifest.skills).sort();
  const plan = [];

  for (const name of names) {
    let skill;
    try {
      skill = readSkill(name);
    } catch {
      // The manifest names a skill this version no longer ships. Nothing to
      // update, and nothing to delete either: the folder on disk is the user's
      // now.
      plan.push({ skill: { name, files: [] }, create: [], write: [], skipEdited: [] });
      continue;
    }

    const { create, write, skipEdited } = classify(
      skill,
      manifest,
      readExisting(skill.name, root),
    );
    plan.push({ skill, create, write, skipEdited });
  }

  return { root, manifest, plan };
}

/** Every skill folder present under `root`, whether or not this installer made it. */
export function installedSkillNames(root) {
  const manifest = readManifest(root);
  return Object.keys(manifest.skills).sort();
}

export { TargetError };
export { existsSync, join };
