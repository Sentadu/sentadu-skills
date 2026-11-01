#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkInstall, checkPackage } from "../lib/doctor.mjs";
import {
  applyInstall,
  conflictsOf,
  InstallError,
  planInstall,
  planUpdate,
} from "../lib/install.mjs";
import { readManifest } from "../lib/manifest.mjs";
import { listSkillNames, readAgents, readAllSkills } from "../lib/skills.mjs";
import { resolveTarget, TargetError } from "../lib/targets.mjs";

/**
 * `sentadu-skills` — install Sentadu agent skills into a project.
 *
 * === EXIT CODES ARE THE INTERFACE ===
 *
 * A person reads the message; a script reads the code. They are distinct on
 * purpose, and the help text lists them, because "it exited 1" and "the files
 * were already there" are different problems with different fixes.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));

export const EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  CONFLICT: 3,
  EDITED: 4,
  NO_TARGET: 5,
};

const USAGE = `sentadu-skills ${PKG.version}

Install Sentadu's agent skills into the directory your coding agent reads.

Usage:
  sentadu-skills list [--json]
  sentadu-skills install [<skill>...] [options]
  sentadu-skills init [options]
  sentadu-skills update [options]
  sentadu-skills doctor [options]

Commands:
  list       Show the bundled skills and their descriptions.
  install    Install the named skills, or nothing when none are named.
  init       Install every bundled skill. Same as \`install\` with all names.
  update     Refresh installed skills. Leaves files you edited untouched.
  doctor     Check the package and the installed copy for problems.

Options:
  --agent <id>   Target one agent: ${readAgents()
    .map((a) => a.id)
    .join(", ")}
  --dir <path>   Use this skills directory instead of an agent's.
  --user         Install into your home directory, not the project.
  --dry-run      Print what would happen. Writes nothing.
  --force        Overwrite existing files. Only use it when you mean it.
  --json         Machine-readable output.
  -h, --help     This text.
  -v, --version  The package version.

Exit codes:
  0  done
  1  something failed
  2  bad usage
  3  files exist and --force was not given
  4  update skipped files you edited
  5  no usable target directory

Examples:
  npx ${PKG.name} init
  npx ${PKG.name} install sentadu-api --agent claude-code
  npx ${PKG.name} update --dry-run
  npx ${PKG.name} doctor --user
`;

function parseArgs(argv) {
  const options = {
    command: null,
    skills: [],
    agent: null,
    dir: null,
    user: false,
    dryRun: false,
    force: false,
    json: false,
  };

  const takeValue = (flag, index) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("-")) {
      throw new UsageError(`${flag} needs a value`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "-v" || arg === "--version") {
      options.version = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--user") {
      options.user = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--agent") {
      options.agent = takeValue(arg, i);
      i += 1;
    } else if (arg === "--dir") {
      options.dir = takeValue(arg, i);
      i += 1;
    } else if (arg.startsWith("-")) {
      throw new UsageError(`unknown option: ${arg}`);
    } else if (options.command === null) {
      options.command = arg;
    } else {
      options.skills.push(arg);
    }
  }

  return options;
}

class UsageError extends Error {}

function fail(message, code = EXIT.ERROR, detail) {
  process.stderr.write(`sentadu-skills: ${message}\n`);
  if (Array.isArray(detail) && detail.length > 0) {
    for (const item of detail) process.stderr.write(`  ${item.skill}/${item.path}\n`);
  }
  return code;
}

/** Resolve targets or explain why there are none. */
function targetsOf(options) {
  const agents = readAgents();
  return resolveTarget({
    agents,
    agentId: options.agent,
    dir: options.dir,
    user: options.user,
    cwd: process.cwd(),
  });
}

function printTargets(targets) {
  for (const target of targets) {
    process.stdout.write(`  ${target.root}  (${target.agents.join(", ")})\n`);
  }
}

// --- commands -----------------------------------------------------------

function cmdList(options) {
  const skills = readAllSkills();

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        skills.map((skill) => ({
          name: skill.name,
          description: skill.description,
          files: skill.files.length,
          bytes: skill.bytes,
        })),
        null,
        2,
      )}\n`,
    );
    return EXIT.OK;
  }

  process.stdout.write(`Sentadu skills, from ${PKG.name} ${PKG.version}\n\n`);
  for (const skill of skills) {
    process.stdout.write(`  ${skill.name}  (${skill.files.length} files)\n`);
    process.stdout.write(`    ${skill.description}\n\n`);
  }
  process.stdout.write(`Install all of them: npx ${PKG.name} init\n`);
  return EXIT.OK;
}

function runInstall(options, names, { update }) {
  const targets = targetsOf(options);

  if (targets.length === 0) {
    return fail("no target directory", EXIT.NO_TARGET);
  }

  let exit = EXIT.OK;

  for (const target of targets) {
    const built = update ? planUpdate({ root: target.root }) : planInstall({
      root: target.root,
      skillNames: names,
      force: options.force,
    });

    const conflicts = conflictsOf(built);
    const changed = built.plan.reduce(
      (sum, entry) => sum + entry.create.length + entry.write.length,
      0,
    );

    if (options.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            root: target.root,
            agents: target.agents,
            dryRun: options.dryRun,
            conflicts,
            changed,
            skills: built.plan.map((entry) => ({
              name: entry.skill.name,
              create: entry.create.map((file) => file.path),
              update: entry.write.map((file) => file.path),
              skip: entry.skipEdited.map((file) => file.path),
            })),
          },
          null,
          2,
        )}\n`,
      );
    } else {
      process.stdout.write(`\n${target.root}  (${target.agents.join(", ")})\n`);
      for (const entry of built.plan) {
        const parts = [];
        if (entry.create.length) parts.push(`${entry.create.length} new`);
        if (entry.write.length) parts.push(`${entry.write.length} updated`);
        if (entry.skipEdited.length) parts.push(`${entry.skipEdited.length} kept`);
        process.stdout.write(
          `  ${entry.skill.name}: ${parts.length ? parts.join(", ") : "nothing to do"}\n`,
        );
      }
      if (options.dryRun) process.stdout.write("  dry run: nothing was written\n");
    }

    if (options.dryRun) {
      if (conflicts.length > 0 && !update) exit = EXIT.CONFLICT;
      if (update && built.plan.some((entry) => entry.skipEdited.length > 0)) exit = EXIT.EDITED;
      continue;
    }

    try {
      const result = applyInstall({ ...built, update });

      if (!options.json) {
        if (result.written.length > 0) {
          process.stdout.write(`  wrote ${result.written.length} file(s)\n`);
        }
        if (result.skipped.length > 0) {
          process.stdout.write(`  left ${result.skipped.length} edited file(s) alone:\n`);
          for (const item of result.skipped) {
            process.stdout.write(`    ${item.skill}/${item.path}\n`);
          }
        }
      }

      if (result.skipped.length > 0) exit = EXIT.EDITED;
    } catch (error) {
      if (error instanceof InstallError && error.code === "CONFLICT") {
        process.stderr.write(
          `sentadu-skills: ${error.message} in ${target.root}\n` +
            "  Re-run with --force to overwrite them, or move them aside first.\n",
        );
        for (const item of error.detail) {
          process.stderr.write(`    ${item.skill}/${item.path}\n`);
        }
        exit = EXIT.CONFLICT;
        continue;
      }
      throw error;
    }
  }

  if (!options.json && exit === EXIT.OK && !update && !options.dryRun) {
    process.stdout.write(`\nNext: your agent picks these up on its next run.\n`);
  }

  return exit;
}

function cmdInstall(options) {
  const names = options.skills.length > 0 ? options.skills : listSkillNames();
  const known = listSkillNames();

  for (const name of names) {
    if (!known.includes(name)) {
      return fail(`no such skill: ${name}. Known: ${known.join(", ")}`, EXIT.USAGE);
    }
  }

  if (options.skills.length === 0) {
    return fail(
      "install needs at least one skill name. Did you mean `init`?",
      EXIT.USAGE,
    );
  }

  return runInstall(options, names, { update: false });
}

function cmdInit(options) {
  if (options.skills.length > 0) {
    return fail(`init installs every skill and takes no names. Got: ${options.skills.join(" ")}`, EXIT.USAGE);
  }
  return runInstall(options, listSkillNames(), { update: false });
}

function cmdUpdate(options) {
  if (options.skills.length > 0) {
    return fail("update refreshes what is already installed and takes no names", EXIT.USAGE);
  }
  return runInstall(options, [], { update: true });
}

function cmdDoctor(options) {
  const findings = checkPackage();
  const targets = options.dir
    ? [{ root: targetsOf(options)[0].root, agents: [] }]
    : targetsOf(options).map((target) => ({ root: target.root, agents: target.agents }));

  for (const target of targets) {
    findings.push(...checkInstall(target.root));
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ version: PKG.version, findings }, null, 2)}\n`);
  } else {
    process.stdout.write(`sentadu-skills ${PKG.version}\n`);
    if (targets.length > 0) {
      process.stdout.write("checked:\n");
      for (const target of targets) {
        process.stdout.write(
          `  ${target.root}${target.agents.length ? `  (${target.agents.join(", ")})` : ""}\n`,
        );
      }
    }

    if (findings.length === 0) {
      process.stdout.write("\nNo problems found.\n");
    } else {
      process.stdout.write("\n");
      for (const finding of findings) {
        const where = [finding.skill, finding.path].filter(Boolean).join("/");
        process.stdout.write(
          `  [${finding.severity ?? "error"}] ${where ? `${where}: ` : ""}${finding.issue}\n`,
        );
        if (finding.hint) process.stdout.write(`      ${finding.hint}\n`);
      }
    }
  }

  const errors = findings.filter((finding) => (finding.severity ?? "error") === "error");
  return errors.length > 0 ? EXIT.ERROR : EXIT.OK;
}

// --- entry --------------------------------------------------------------

function cmdManifest(options) {
  // The manifest is diagnostic output, not a command; `doctor --json` is enough.
  const targets = targetsOf(options);
  const manifests = targets.map((target) => ({
    root: target.root,
    manifest: readManifest(target.root),
  }));
  process.stdout.write(`${JSON.stringify(manifests, null, 2)}\n`);
  return EXIT.OK;
}

const COMMANDS = {
  list: cmdList,
  install: cmdInstall,
  init: cmdInit,
  update: cmdUpdate,
  doctor: cmdDoctor,
  manifest: cmdManifest,
};

export function run(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    return fail(error.message, EXIT.USAGE);
  }

  if (options.help || (!options.command && !options.version)) {
    process.stdout.write(USAGE);
    return options.help ? EXIT.OK : EXIT.USAGE;
  }

  if (options.version) {
    process.stdout.write(`${PKG.version}\n`);
    return EXIT.OK;
  }

  const command = COMMANDS[options.command];
  if (!command) {
    return fail(`unknown command: ${options.command}. Try --help.`, EXIT.USAGE);
  }

  try {
    return command(options);
  } catch (error) {
    if (error instanceof UsageError) return fail(error.message, EXIT.USAGE);
    if (error instanceof TargetError) return fail(error.message, EXIT.USAGE);
    return fail(error.message ?? String(error), EXIT.ERROR);
  }
}

/**
 * Only run when this file is the entry point, so the tests can import `run`.
 *
 * === REALPATHS, NOT STRING EQUALITY ===
 *
 * `npx` and `node_modules/.bin` invoke this through a SYMLINK, so `argv[1]` is
 * `.../.bin/sentadu-skills` while `import.meta.url` points at
 * `.../@sentadu/skills/bin/cli.mjs`. Comparing those strings is false, the module
 * exports `run` and calls nothing, and the command exits 0 having done NOTHING --
 * the worst possible failure, because it looks like success. Resolving both
 * sides first is what makes the guard work through the path npm actually uses.
 */
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.exitCode = run(process.argv.slice(2));
}
