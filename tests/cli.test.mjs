import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { parseFrontmatter, readAllSkills, validateSkill } from "../lib/skills.mjs";
import { safeJoin, TargetError } from "../lib/targets.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "bin", "cli.mjs");

/** Run the CLI in `cwd` and capture both streams and the exit code. */
function cli(args, cwd) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      code: error.status ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

function scratch() {
  return mkdtempSync(join(tmpdir(), "sentadu-skills-"));
}

// --- the package --------------------------------------------------------

test("every shipped skill has valid frontmatter and its name matches the folder", () => {
  const skills = readAllSkills();

  assert.ok(skills.length >= 3, `expected three skills, got ${skills.length}`);

  for (const skill of skills) {
    // A malformed skill is not loaded by an agent, and the failure is SILENT:
    // the skill simply never appears. So this is the one check that must not
    // pass on a warning.
    assert.deepEqual(validateSkill(skill), [], `${skill.name} must be valid`);
    assert.ok(skill.files.length > 1, `${skill.name} must have more than SKILL.md`);
  }
});

test("the frontmatter reader takes folded values, quotes and nested maps", () => {
  const folded = parseFrontmatter("---\nname: x\ndescription: >\n  one\n  two\n---\n");
  assert.equal(folded.name, "x");
  assert.equal(folded.description, "one two");

  const quoted = parseFrontmatter("---\nname: x\ndescription: 'a: b'\n---\n");
  assert.equal(quoted.description, "a: b");

  const nested = parseFrontmatter("---\nname: x\nmetadata:\n  author: sentadu\n---\n");
  assert.equal(nested.metadata, "");

  assert.deepEqual(parseFrontmatter("# no frontmatter\n"), {});
});

test("validateSkill reports the folder/name mismatch rather than accepting it", () => {
  const skill = readAllSkills()[0];
  const broken = {
    ...skill,
    files: skill.files.map((file) =>
      file.path === "SKILL.md"
        ? { ...file, content: file.content.replace(/^name: .*$/m, "name: something-else") }
        : file,
    ),
  };

  assert.match(validateSkill(broken).join(" "), /does not match the folder/);
});

// --- the CLI ------------------------------------------------------------

test("--help and --version exit 0, and an unknown command is a usage error", () => {
  const dir = scratch();
  try {
    const help = cli(["--help"], dir);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /sentadu-skills/);

    const version = cli(["--version"], dir);
    assert.equal(version.code, 0);
    assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);

    const unknown = cli(["frobnicate"], dir);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /unknown command/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("list names every skill, and --json parses", () => {
  const dir = scratch();
  try {
    const text = cli(["list"], dir);
    assert.equal(text.code, 0);
    for (const name of ["sentadu-api", "sentadu-webhooks", "sentadu-security"]) {
      assert.ok(text.stdout.includes(name), `${name} must be listed`);
    }

    const json = JSON.parse(cli(["list", "--json"], dir).stdout);
    assert.ok(Array.isArray(json));
    assert.ok(json.every((skill) => skill.name && skill.description && skill.files > 0));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init writes both agent trees and a manifest, and dedupes the shared one", () => {
  const dir = scratch();
  try {
    const result = cli(["init"], dir);
    assert.equal(result.code, 0, result.stderr);

    for (const agentRoot of [".claude/skills", ".agents/skills"]) {
      for (const name of ["sentadu-api", "sentadu-webhooks", "sentadu-security"]) {
        assert.ok(
          existsSync(join(dir, agentRoot, name, "SKILL.md")),
          `${agentRoot}/${name}/SKILL.md must exist`,
        );
      }
      // The two scripts are meant to run, so the executable bit has to survive.
      const smoke = join(dir, agentRoot, "sentadu-api", "scripts", "smoke.sh");
      assert.equal(statSync(smoke).mode & 0o111, 0o111, `${smoke} must be executable`);
    }

    const manifest = JSON.parse(readFileSync(join(dir, ".claude/skills/.sentadu-skills.json"), "utf8"));
    assert.deepEqual(Object.keys(manifest.skills).sort(), [
      "sentadu-api",
      "sentadu-security",
      "sentadu-webhooks",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--agent cursor and --agent codex resolve to the SAME directory", () => {
  const dir = scratch();
  try {
    const codex = JSON.parse(cli(["init", "--agent", "codex", "--json"], dir).stdout);
    rmSync(join(dir, ".agents"), { recursive: true, force: true });
    const cursor = JSON.parse(cli(["init", "--agent", "cursor", "--json"], dir).stdout);

    // Codex and Cursor both read .agents/skills. If they resolved to different
    // roots, Cursor would see the skill twice.
    assert.equal(codex.root, cursor.root);
    assert.equal(codex.root, join(dir, ".agents", "skills"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--agent claude-code and --agent codex resolve to DIFFERENT directories", () => {
  const dir = scratch();
  try {
    const claude = JSON.parse(cli(["init", "--agent", "claude-code", "--json"], dir).stdout);
    const codex = JSON.parse(cli(["init", "--agent", "codex", "--json"], dir).stdout);
    assert.notEqual(claude.root, codex.root);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("install takes a subset, and an unknown name is refused without writing", () => {
  const dir = scratch();
  try {
    const ok = cli(["install", "sentadu-security", "--agent", "claude-code"], dir);
    assert.equal(ok.code, 0, ok.stderr);
    assert.ok(existsSync(join(dir, ".claude/skills/sentadu-security/SKILL.md")));
    assert.ok(!existsSync(join(dir, ".claude/skills/sentadu-api")), "only the named skill");

    const bad = cli(["install", "nope", "--agent", "claude-code"], dir);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /no such skill/);

    // `install` with no names is a usage error, not a silent install-everything.
    const empty = cli(["install", "--agent", "claude-code"], dir);
    assert.equal(empty.code, 2);
    assert.match(empty.stderr, /Did you mean `init`/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--dry-run writes nothing, then the real run produces exactly the plan", () => {
  const dir = scratch();
  try {
    const dry = JSON.parse(cli(["init", "--agent", "claude-code", "--dry-run", "--json"], dir).stdout);
    assert.equal(dry.changed > 0, true);
    assert.ok(!existsSync(join(dir, ".claude")), "a dry run must not create the directory");

    cli(["init", "--agent", "claude-code"], dir);
    for (const skill of dry.skills) {
      for (const path of [...skill.create, ...skill.update]) {
        assert.ok(
          existsSync(join(dir, ".claude/skills", skill.name, path)),
          `${skill.name}/${path} was planned and must exist`,
        );
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an existing file that this installer did not write is a conflict, not an overwrite", () => {
  const dir = scratch();
  try {
    mkdirSync(join(dir, ".claude/skills/sentadu-api"), { recursive: true });
    writeFileSync(join(dir, ".claude/skills/sentadu-api/SKILL.md"), "mine\n");

    const refused = cli(["init", "--agent", "claude-code"], dir);
    assert.equal(refused.code, 3, "a conflict must be its own exit code");
    assert.equal(
      readFileSync(join(dir, ".claude/skills/sentadu-api/SKILL.md"), "utf8"),
      "mine\n",
      "the file must be untouched",
    );
    assert.ok(
      !existsSync(join(dir, ".claude/skills/.sentadu-skills.json")),
      "a refused install writes no manifest",
    );

    const forced = cli(["init", "--agent", "claude-code", "--force"], dir);
    assert.equal(forced.code, 0, forced.stderr);
    assert.notEqual(readFileSync(join(dir, ".claude/skills/sentadu-api/SKILL.md"), "utf8"), "mine\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("update leaves an edited file alone and exits 4", () => {
  const dir = scratch();
  try {
    cli(["init", "--agent", "claude-code"], dir);

    const edited = join(dir, ".claude/skills/sentadu-api/SKILL.md");
    writeFileSync(edited, `${readFileSync(edited, "utf8")}\nmy notes\n`);

    const result = cli(["update", "--agent", "claude-code"], dir);
    assert.equal(result.code, 4, "an edited file must be reported as such");
    assert.match(result.stdout, /left/, "and named");
    assert.match(readFileSync(edited, "utf8"), /my notes/, "the user's edit survives");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("update refreshes an unmodified install and exits 0", () => {
  const dir = scratch();
  try {
    cli(["init", "--agent", "claude-code"], dir);

    const result = cli(["update", "--agent", "claude-code"], dir);
    assert.equal(result.code, 0, result.stderr);
    // Every owned file still matches the manifest, so update is free to rewrite
    // it. A release that changed a reference is exactly this case.
    assert.ok(existsSync(join(dir, ".claude/skills/sentadu-api/references/errors.md")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("update on a directory with nothing installed is a no-op that exits 0", () => {
  const dir = scratch();
  try {
    const result = cli(["update", "--agent", "claude-code"], dir);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(!existsSync(join(dir, ".claude")), "nothing to update means nothing to create");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor passes on a fresh install and reports a missing file after a delete", () => {
  const dir = scratch();
  try {
    cli(["init", "--agent", "claude-code"], dir);

    const clean = cli(["doctor", "--agent", "claude-code"], dir);
    assert.equal(clean.code, 0, clean.stdout);
    assert.match(clean.stdout, /No problems found/);

    rmSync(join(dir, ".claude/skills/sentadu-api/references/errors.md"));
    const broken = cli(["doctor", "--agent", "claude-code"], dir);
    assert.equal(broken.code, 1);
    assert.match(broken.stdout, /missing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--dir installs where it is told, and a name that escapes is refused", () => {
  const dir = scratch();
  try {
    const custom = join(dir, "somewhere", "skills");
    const ok = cli(["init", "--dir", custom], dir);
    assert.equal(ok.code, 0, ok.stderr);
    assert.ok(existsSync(join(custom, "sentadu-api/SKILL.md")));

    // `safeJoin` is the single gate every write passes through. A skill name of
    // `../..` must not escape the root it was given.
    assert.throws(() => safeJoin(custom, "../outside.md"), TargetError);
    assert.throws(() => safeJoin(custom, "..", "..", "etc", "passwd"), TargetError);
    assert.equal(safeJoin(custom, "sentadu-api", "SKILL.md"), join(custom, "sentadu-api/SKILL.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the CLI works when invoked through a symlink, the way .bin does", () => {
  const dir = scratch();
  try {
    /**
     * THIS SHIPPED BROKEN ONCE, AND SILENTLY.
     *
     * The entry-point guard compared `fileURLToPath(import.meta.url)` with
     * `process.argv[1]`. `npx` and `node_modules/.bin` run the file through a
     * symlink, so the strings differ, the guard was false, no command ran, and
     * the process exited 0 -- looking like success while doing nothing at all.
     * A copy of the CLI behind a link is exactly how npm delivers it.
     */
    const link = join(dir, "linked-cli.mjs");
    symlinkSync(CLI, link);

    const listed = execFileSync(process.execPath, [link, "list"], { encoding: "utf8" });
    assert.match(listed, /sentadu-api/, "the linked entry point must still run");

    const version = execFileSync(process.execPath, [link, "--version"], { encoding: "utf8" });
    assert.match(version.trim(), /^\d+\.\d+\.\d+$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--dry-run says nothing was written and promises no next step", () => {
  const dir = scratch();
  try {
    const result = cli(["init", "--agent", "claude-code", "--dry-run"], dir);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /nothing was written/);
    assert.ok(
      !result.stdout.includes("picks these up"),
      "a dry run must not tell the reader the agent will find files it did not write",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a symlink in the destination is refused, never written through", () => {
  const dir = scratch();
  try {
    const outside = join(dir, "outside");
    mkdirSync(outside, { recursive: true });
    mkdirSync(join(dir, ".claude/skills/sentadu-api"), { recursive: true });
    symlinkSync(outside, join(dir, ".claude/skills/sentadu-api/references"));

    const result = cli(["init", "--agent", "claude-code", "--force"], dir);
    assert.equal(result.code, 1, "a symlink is a hard failure");
    assert.match(result.stderr, /symlink/);
    assert.ok(!existsSync(join(outside, "errors.md")), "nothing may land outside the tree");
    assert.ok(!existsSync(join(outside, "endpoints.md")), "nothing may land outside the tree");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
