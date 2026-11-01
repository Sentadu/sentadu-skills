import { lstatSync, readFileSync } from "node:fs";
import { readManifest } from "./manifest.mjs";
import { readAllSkills, validateSkill, hashContent } from "./skills.mjs";
import { safeJoin } from "./targets.mjs";

/**
 * `doctor`: what is wrong with this package, and what is wrong with the copy in
 * this directory.
 *
 * Two different questions, and answering only one of them is how a user ends up
 * with a package that is fine and an install that is stale, or the reverse.
 * Every finding is a plain object so `--json` needs no second code path.
 */

/**
 * The shipped skills, checked against the rules an agent actually enforces.
 *
 * A skill whose frontmatter is malformed is not loaded at all, and the failure is
 * silent: the agent simply never mentions the skill. That is why this is a check
 * and not an assumption.
 */
export function checkPackage() {
  const problems = [];

  for (const skill of readAllSkills()) {
    for (const issue of validateSkill(skill)) {
      problems.push({ scope: "package", skill: skill.name, issue });
    }

    if (skill.files.length === 1) {
      problems.push({
        scope: "package",
        skill: skill.name,
        issue: "only SKILL.md; a skill with no references is usually a truncated copy",
      });
    }
  }

  return problems;
}

/**
 * The copy under `root`, compared with the package.
 *
 * `edited` is not a fault: the whole point of the manifest is that a user may
 * change what they installed. It is reported so they know `update` will leave it
 * alone, not so they feel wrong about it.
 */
export function checkInstall(root) {
  const manifest = readManifest(root);
  const shipped = new Map(readAllSkills().map((skill) => [skill.name, skill]));
  const findings = [];

  const installed = Object.keys(manifest.skills);

  if (installed.length === 0) {
    findings.push({
      scope: "install",
      severity: "info",
      issue: "nothing installed here",
      hint: "run: sentadu-skills init",
    });
    return findings;
  }

  for (const name of installed) {
    const skill = shipped.get(name);

    if (!skill) {
      findings.push({
        scope: "install",
        skill: name,
        severity: "info",
        issue: "installed, but this version of the package no longer ships it",
        hint: "delete the folder if you do not want it",
      });
      continue;
    }

    const owned = manifest.skills[name]?.files ?? {};
    let missing = 0;
    let edited = 0;

    for (const file of skill.files) {
      const full = safeJoin(root, name, file.path);
      let onDisk = null;
      try {
        const stat = lstatSync(full);
        if (stat.isSymbolicLink()) {
          findings.push({
            scope: "install",
            skill: name,
            path: file.path,
            severity: "warn",
            issue: "is a symlink; update will refuse to write through it",
          });
          continue;
        }
        onDisk = readFileSync(full, "utf8");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }

      if (onDisk === null) {
        missing += 1;
        continue;
      }

      // Compare the bytes ON DISK with the bytes IN THE PACKAGE. The manifest's
      // hash is what says whether this installer wrote them; `file.hash` is what
      // they would be after an update. When the two agree the file is ours and
      // current, and when the disk hash matches the manifest but not the package
      // it is merely stale, which is not a problem to report.
      const diskHash = hashContent(onDisk);
      if (diskHash !== file.hash && diskHash !== owned[file.path]) edited += 1;
    }

    if (missing > 0) {
      findings.push({
        scope: "install",
        skill: name,
        severity: "error",
        issue: `${missing} file(s) missing, so the skill is incomplete`,
        hint: "run: sentadu-skills update",
      });
    }

    if (edited > 0) {
      findings.push({
        scope: "install",
        skill: name,
        severity: "info",
        issue: `${edited} file(s) differ from the shipped copy`,
        hint: "update will leave these alone",
      });
    }
  }

  return findings;
}
