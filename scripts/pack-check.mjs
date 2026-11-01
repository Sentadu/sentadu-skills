#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * What `npm publish` would actually upload, checked before it uploads it.
 *
 * === WHY THIS IS NOT A TEST ===
 *
 * A test asserts behaviour of code in the repo. This asserts the CONTENTS of a
 * tarball that npm builds from `files` rules, `.npmignore`, and npm's own
 * defaults, none of which the test runner sees. The failure it prevents is the
 * one that cannot be undone: a version on the registry that contains a secret,
 * or a stray file, or a missing skill.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

const ALLOWED_TOP_LEVEL = new Set([
  "package.json",
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
  "bin",
  "lib",
  "skills",
  "adapters",
]);

/**
 * Patterns that must never appear in a published file.
 *
 * `sdk_live_` and `sdk_test_` are included deliberately: the skills are
 * DOCUMENTATION and quote the key shape, so the check is for a key-shaped string
 * with a real-looking secret, not the prefix alone. The `BEGIN` pattern catches a
 * private key pasted in by accident.
 */
const SECRET_PATTERNS = [
  [/sdk_(live|test)_[a-f0-9]{8}\.[A-Za-z0-9_-]{20,}/, "a real-looking Sentadu API key"],
  [/whsec_[A-Za-z0-9_-]{16,}/, "a real-looking webhook secret"],
  [/ibk_[A-Za-z0-9]{10,}/, "an instabox API key"],
  [/npm_[A-Za-z0-9]{20,}/, "an npm token"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/vercel_blob_rw_[A-Za-z0-9_]{10,}/, "a Vercel Blob token"],
];

function fail(message) {
  process.stderr.write(`pack-check: ${message}\n`);
  process.exit(1);
}

// --- what npm says it will pack ------------------------------------------

let manifest;
try {
  manifest = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
} catch (error) {
  fail(`npm pack --dry-run failed: ${error.stderr ?? error.message}`);
}

const [packed] = manifest;
if (!packed || !Array.isArray(packed.files)) fail("npm pack returned no file list");

const files = packed.files.map((file) => file.path.replace(/^package\//, ""));

// --- the checks ----------------------------------------------------------

const problems = [];

for (const path of files) {
  const top = path.split("/")[0];
  if (!ALLOWED_TOP_LEVEL.has(top)) {
    problems.push(`unexpected file in the tarball: ${path}`);
  }
}

// The three skills are the product. A release that drops one is a release that
// silently uninstalls it for everyone who updates.
for (const skill of ["sentadu-api", "sentadu-webhooks", "sentadu-security"]) {
  if (!files.includes(`skills/${skill}/SKILL.md`)) {
    problems.push(`missing skills/${skill}/SKILL.md`);
  }
}

if (!files.includes("bin/cli.mjs")) problems.push("missing bin/cli.mjs");
if (!files.includes("adapters/agents.json")) problems.push("missing adapters/agents.json");

// A test or a fixture in the tarball is dead weight, and a sign that `files`
// stopped doing its job.
for (const path of files) {
  if (path.startsWith("tests/") || path.startsWith("scripts/")) {
    problems.push(`build-time file leaked into the tarball: ${path}`);
  }
}

for (const path of files) {
  let content;
  try {
    content = readFileSync(join(ROOT, path), "utf8");
  } catch {
    continue; // binary or unreadable; nothing to grep
  }

  for (const [pattern, label] of SECRET_PATTERNS) {
    if (pattern.test(content)) problems.push(`${path} contains ${label}`);
  }
}

if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`  ${problem}\n`);
  fail(`${problems.length} problem(s); not publishing this tarball`);
}

const bytes = packed.size ?? 0;
const unpacked = packed.unpackedSize ?? 0;

process.stdout.write(
  `pack-check: ${files.length} files, ${Math.round(bytes / 1024)} KB packed, ` +
    `${Math.round(unpacked / 1024)} KB unpacked, no secrets\n`,
);
process.stdout.write(`  ${pkg.name}@${pkg.version}\n`);
