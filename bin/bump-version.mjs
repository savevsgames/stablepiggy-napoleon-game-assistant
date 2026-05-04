#!/usr/bin/env node
// bump-version.mjs — interactive semver bump for module.json + package.json.
//
// Why this exists: the .github/workflows/release-image.yml workflow has a
// hard check that module.json's version field must match the git tag
// being pushed (minus the leading 'v'). If they drift, the workflow
// fails fast and no image is built. This script keeps the two version
// fields in sync and walks through a patch/minor/major prompt so the
// bump is intentional rather than freehand.
//
// Usage: from the repo root, run `npm run bump:version` (or
// `node bin/bump-version.mjs` directly).
//
// What it does:
//   1. Reads current version from module.json + package.json
//   2. Warns if they're out of sync (and refuses to proceed)
//   3. Prompts for bump type: patch / minor / major
//   4. Computes new version per semver rules
//   5. Writes both files
//   6. Prints the next git commands to run (commit + tag + push)
//
// What it does NOT do:
//   - git add / commit / tag / push — all manual, by intent. The script
//     edits files; the operator decides when to commit and tag. Avoids
//     "I bumped the wrong version and the script auto-tagged it" foot-
//     gun.
//   - Pre-release tags (rc, beta, etc). If we ever need them, add a
//     fourth prompt option.
//
// Files touched:
//   - module.json    (canonical source per FOUNDRY-HARNESS-V2 spec)
//   - package.json   (kept in sync so npm tooling agrees)

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const MODULE_JSON_PATH = resolve(REPO_ROOT, 'module.json');
const PACKAGE_JSON_PATH = resolve(REPO_ROOT, 'package.json');

// ── Read + validate ───────────────────────────────────────────────

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function parseSemver(version) {
  // Strict M.N.P parse — refuses pre-release / build metadata for
  // simplicity. The workflow's tag pattern is `v*.*.*` so any tag with
  // a hyphen suffix would already be excluded from the publish path.
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new Error(
      `Version "${version}" doesn't match strict M.N.P semver. ` +
      `Pre-release suffixes (rc.N, beta, etc) aren't supported by this script.`,
    );
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function formatSemver({ major, minor, patch }) {
  return `${major}.${minor}.${patch}`;
}

function bump(current, kind) {
  switch (kind) {
    case 'patch':
      return { ...current, patch: current.patch + 1 };
    case 'minor':
      return { major: current.major, minor: current.minor + 1, patch: 0 };
    case 'major':
      return { major: current.major + 1, minor: 0, patch: 0 };
    default:
      throw new Error(`Unknown bump kind: ${kind}`);
  }
}

// ── Prompt + flow ─────────────────────────────────────────────────

async function main() {
  const moduleJson = readJson(MODULE_JSON_PATH);
  const packageJson = readJson(PACKAGE_JSON_PATH);

  const moduleVersion = moduleJson.version;
  const packageVersion = packageJson.version;

  if (moduleVersion !== packageVersion) {
    console.error(
      `Version mismatch detected:\n` +
      `  module.json  -> ${moduleVersion}\n` +
      `  package.json -> ${packageVersion}\n\n` +
      `Resolve manually before bumping. Both files must agree on the ` +
      `current version so the new one lands cleanly in sync.`,
    );
    process.exit(1);
  }

  const current = parseSemver(moduleVersion);
  const cur = formatSemver(current);

  const candidates = {
    '1': { kind: 'patch', next: formatSemver(bump(current, 'patch')) },
    '2': { kind: 'minor', next: formatSemver(bump(current, 'minor')) },
    '3': { kind: 'major', next: formatSemver(bump(current, 'major')) },
  };

  console.log(`Current version: ${cur}\n`);
  console.log(`Pick a bump:`);
  console.log(`  1) patch  ${cur}  ->  ${candidates['1'].next}`);
  console.log(`  2) minor  ${cur}  ->  ${candidates['2'].next}`);
  console.log(`  3) major  ${cur}  ->  ${candidates['3'].next}`);
  console.log(``);

  const rl = createInterface({ input, output });
  let choice;
  try {
    const raw = (await rl.question('Choice [1/2/3] (or q to abort): ')).trim().toLowerCase();
    if (raw === 'q' || raw === 'quit' || raw === 'exit' || raw === '') {
      console.log('Aborted, no files changed.');
      process.exit(0);
    }
    choice = candidates[raw];
    if (!choice) {
      console.error(`Invalid choice "${raw}". Expected 1, 2, or 3.`);
      process.exit(1);
    }
  } finally {
    rl.close();
  }

  const newVersion = choice.next;

  // Write module.json — preserve key order by mutating in place. The
  // existing JSON parse + stringify roundtrip is good enough for our
  // shape (no comments, no trailing commas).
  moduleJson.version = newVersion;
  writeFileSync(MODULE_JSON_PATH, JSON.stringify(moduleJson, null, 2) + '\n');

  packageJson.version = newVersion;
  writeFileSync(PACKAGE_JSON_PATH, JSON.stringify(packageJson, null, 2) + '\n');

  console.log(``);
  console.log(`Bumped ${cur} -> ${newVersion} (${choice.kind})`);
  console.log(`  module.json   updated`);
  console.log(`  package.json  updated`);
  console.log(``);
  console.log(`Next steps (manual):`);
  console.log(`  git add module.json package.json`);
  console.log(`  git commit -m "chore: bump version to ${newVersion}"`);
  console.log(`  git push`);
  console.log(`  git tag v${newVersion}`);
  console.log(`  git push origin v${newVersion}`);
  console.log(``);
  console.log(`The tag push fires release-image.yml on Docker Hub + GitHub Release.`);
}

main().catch((err) => {
  console.error(`bump-version failed: ${err.message}`);
  process.exit(1);
});
