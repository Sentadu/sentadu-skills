import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The bundled skills, as data.
 *
 * === ONE READER FOR THE LIST, THE INSTALLER AND `doctor` ===
 *
 * Three commands need to know what a skill folder contains. If each walked the
 * tree itself, `list` could name a file `install` would not write. So the walk,
 * the ordering and the hashing live here.
 *
 * PURE: `node:fs` and `node:crypto` only, so the tests import it directly.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
export const SKILLS_ROOT = join(HERE, "..", "skills");
export const ADAPTERS_FILE = join(HERE, "..", "adapters", "agents.json");

/** The name a skill folder must have, and the name in its frontmatter. */
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The hash used in the install manifest, and therefore in drift detection. */
export function hashContent(content) {
  return createHash("sha256").update(content).digest("hex");
}

function walk(dir, root) {
  const found = [];

  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...walk(full, root));
    } else {
      found.push(relative(root, full).split(sep).join("/"));
    }
  }

  return found;
}

/**
 * Read one skill folder.
 *
 * Throws rather than returning a partial skill: an installer that silently skips
 * a broken folder leaves the user with a skill that looks installed and is not.
 */
export function readSkill(name) {
  if (!NAME_RE.test(name)) {
    throw new Error(`invalid skill name: ${JSON.stringify(name)}`);
  }

  const root = join(SKILLS_ROOT, name);
  const paths = walk(root, root);

  if (!paths.includes("SKILL.md")) {
    throw new Error(`skill ${name} has no SKILL.md`);
  }

  const files = paths.map((path) => {
    const content = readFileSync(join(root, path), "utf8");
    return {
      path,
      content,
      hash: hashContent(content),
      bytes: Buffer.byteLength(content, "utf8"),
      executable: path.startsWith("scripts/"),
    };
  });

  const skill = files.find((file) => file.path === "SKILL.md");

  return {
    name,
    description: parseFrontmatter(skill.content).description ?? "",
    files,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
  };
}

/** Every bundled skill name, sorted. */
export function listSkillNames() {
  return readdirSync(SKILLS_ROOT)
    .filter((entry) => statSync(join(SKILLS_ROOT, entry)).isDirectory())
    .sort();
}

/** Every bundled skill, read. */
export function readAllSkills() {
  return listSkillNames().map(readSkill);
}

/**
 * The two keys an Agent Skill must have.
 *
 * Deliberately not a YAML parser. The frontmatter this package ships is a small
 * fixed shape, and a hand-rolled reader that only understands that shape fails
 * loudly on anything else instead of guessing. A real parser is a dependency,
 * and a dependency here would be the largest thing in the package.
 */
export function parseFrontmatter(content) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(content);
  if (!match) return {};

  const fields = {};
  let current = null;

  for (const raw of match[1].split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;

    const top = /^([a-z][a-z0-9-]*):\s*(.*)$/i.exec(raw);
    if (top) {
      const [, key, value] = top;
      if (value === "" || value === ">" || value === "|") {
        current = key;
        fields[key] = "";
      } else {
        current = null;
        fields[key] = unquote(value);
      }
      continue;
    }

    if (current && /^\s+/.test(raw)) {
      // A nested map's first line is `key: value` too, and folding it into the
      // parent would turn `metadata: {author: sentadu}` into the string
      // "author: sentadu". Only indented prose continues a folded scalar.
      if (/^\s+[A-Za-z][A-Za-z0-9_-]*:/.test(raw)) continue;
      fields[current] = fields[current] ? `${fields[current]} ${raw.trim()}` : raw.trim();
    }
  }

  return fields;
}

function unquote(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Every reason a skill would not be picked up by an agent, as a list of strings.
 * Empty means valid.
 */
export function validateSkill(skill) {
  const problems = [];
  const skillFile = skill.files.find((file) => file.path === "SKILL.md");

  if (!skillFile) {
    return ["SKILL.md is missing"];
  }

  const fields = parseFrontmatter(skillFile.content);

  if (!fields.name) {
    problems.push("frontmatter has no name");
  } else if (fields.name !== skill.name) {
    problems.push(`frontmatter name "${fields.name}" does not match the folder "${skill.name}"`);
  } else if (!NAME_RE.test(fields.name)) {
    problems.push(`name "${fields.name}" is not lowercase letters, digits and hyphens`);
  }

  if (!fields.description) {
    problems.push("frontmatter has no description");
  } else if (fields.description.length > 1024) {
    problems.push(`description is ${fields.description.length} characters, over the 1024 limit`);
  }

  if (skillFile.content.split(/\r?\n/).length > 500) {
    problems.push("SKILL.md is over 500 lines; move detail into references/");
  }

  return problems;
}

/** The adapter table. */
export function readAgents() {
  return JSON.parse(readFileSync(ADAPTERS_FILE, "utf8")).agents;
}
