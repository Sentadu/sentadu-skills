import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashContent } from "./skills.mjs";

/**
 * The record of what this installer put where.
 *
 * === WHY A FILE IN THE SKILLS DIRECTORY, NOT A GLOBAL ONE ===
 *
 * The manifest has to travel with the tree it describes. A copy committed into a
 * repository, cloned on another machine, has to answer "what did the installer
 * write, and has anyone changed it since" on THAT machine. A manifest in
 * `~/.config` answers for the machine that ran the install and nothing else.
 *
 * It sits in the skills root, next to the skill folders, and is named so it is
 * obviously not a skill.
 */

export const MANIFEST_NAME = ".sentadu-skills.json";
const CURRENT_VERSION = 1;

export function manifestPath(root) {
  return join(root, MANIFEST_NAME);
}

/** The manifest, or an empty one when the directory has never been installed into. */
export function readManifest(root) {
  let raw;
  try {
    raw = readFileSync(manifestPath(root), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { version: CURRENT_VERSION, skills: {} };
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A corrupt manifest is not a reason to refuse to work: the consequence of
    // ignoring it is that `update` treats every file as unowned and skips it,
    // which is the safe direction.
    return { version: CURRENT_VERSION, skills: {} };
  }

  if (!parsed || typeof parsed.skills !== "object" || parsed.skills === null) {
    return { version: CURRENT_VERSION, skills: {} };
  }

  return { version: parsed.version ?? CURRENT_VERSION, skills: parsed.skills };
}

export function writeManifest(root, manifest) {
  writeFileSync(manifestPath(root), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

/**
 * Merge one skill's file hashes into a manifest.
 *
 * Replaces the skill's whole entry rather than merging field by field: a file
 * removed from the package must stop being owned, and a merge would leave it
 * behind forever.
 */
export function recordSkill(manifest, skill) {
  const files = {};
  for (const file of skill.files) files[file.path] = file.hash;

  return {
    ...manifest,
    version: CURRENT_VERSION,
    skills: { ...manifest.skills, [skill.name]: { version: skill.version ?? null, files } },
  };
}

/**
 * Split a skill's files into what may be written and what must be left alone.
 *
 * A file is OWNED when the manifest says this installer wrote it and the bytes on
 * disk still hash to what the manifest recorded. Anything else is the user's:
 * a new file they made, or a file they edited, and `update` never touches those.
 */
export function classify(skill, manifest, readExisting) {
  const owned = manifest.skills[skill.name]?.files ?? {};
  const write = [];
  const skipEdited = [];
  const create = [];

  for (const file of skill.files) {
    const existing = readExisting(file.path);

    if (existing === null) {
      create.push(file);
      continue;
    }

    const recorded = owned[file.path];

    // The manifest compares BYTES ON DISK against BYTES IN THE PACKAGE, not
    // against the shipped hash: the two differ exactly when the user edited the
    // file after installing it, which is the only case `update` must not touch.
    if (recorded && recorded === hashContent(existing)) {
      write.push(file);
      continue;
    }

    skipEdited.push(file);
  }

  return { create, write, skipEdited };
}
