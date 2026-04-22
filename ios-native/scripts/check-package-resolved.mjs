#!/usr/bin/env node
// CI check: cross-references the PACKAGES inventory in
// ios-native/scripts/generate-pbxproj.mjs against
// ios-native/CommandComms.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved
//
// Fails if:
//   - Package.resolved is missing or unparseable
//   - Any entry in PACKAGES has no matching pin (by repository URL)
//   - The pin's resolved version is below the PACKAGES `minVersion`
//   - A pin is missing a usable version (branch / commit-only pins)
//
// This catches drift that the pbxproj check can't see: developers who bump
// `minVersion` in generate-pbxproj.mjs without re-resolving SPM, or who
// commit a stale Package.resolved that still pins an older release.
//
// Run locally with:
//   node ios-native/scripts/check-package-resolved.mjs

import { readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

import { PACKAGES, PROJECT_ROOT } from "./generate-pbxproj.mjs";

const RESOLVED_PATH = join(
  PROJECT_ROOT,
  "CommandComms.xcodeproj",
  "project.xcworkspace",
  "xcshareddata",
  "swiftpm",
  "Package.resolved",
);

const FIX_HINT =
  "Open ios-native/CommandComms.xcodeproj in Xcode and run\n" +
  "  File > Packages > Update to Latest Package Versions\n" +
  "then commit the updated Package.resolved.";

function fail(messages) {
  for (const m of messages) {
    console.error("\n[check-package-resolved] " + m);
  }
  process.exit(1);
}

if (!existsSync(RESOLVED_PATH)) {
  fail([
    `Missing ${relative(process.cwd(), RESOLVED_PATH)}.\n` +
      "Resolve Swift packages in Xcode and commit the generated file.\n" +
      FIX_HINT,
  ]);
}

let resolved;
try {
  resolved = JSON.parse(readFileSync(RESOLVED_PATH, "utf8"));
} catch (e) {
  fail([
    `Could not parse ${relative(process.cwd(), RESOLVED_PATH)}: ${e.message}`,
  ]);
}

const pins = Array.isArray(resolved?.pins)
  ? resolved.pins
  : Array.isArray(resolved?.object?.pins)
    ? resolved.object.pins
    : null;
if (!pins) {
  fail([
    `${relative(process.cwd(), RESOLVED_PATH)} has no \`pins\` array — ` +
      "the file looks corrupt. Re-resolve packages in Xcode.",
  ]);
}

// Normalize a repo URL so http/https, trailing slashes, .git suffix and case
// don't cause spurious mismatches.
function normalizeURL(url) {
  if (!url) return "";
  return String(url)
    .trim()
    .toLowerCase()
    .replace(/^http:\/\//, "https://")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
}

// Strict semver compare for "MAJOR.MINOR.PATCH" with optional "-prerelease".
// Returns negative if a < b, 0 if equal, positive if a > b. Pre-release
// versions sort below their release counterpart (1.0.0-rc1 < 1.0.0).
function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre] = String(v).split("-", 2);
    const parts = core.split(".").map((n) => parseInt(n, 10));
    while (parts.length < 3) parts.push(0);
    return { parts, pre: pre ?? null };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa.parts[i] !== pb.parts[i]) return pa.parts[i] - pb.parts[i];
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1; // release > prerelease
  if (pb.pre === null) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

const errors = [];
const pinsByURL = new Map();
for (const pin of pins) {
  const loc = pin.location ?? pin.repositoryURL;
  if (loc) pinsByURL.set(normalizeURL(loc), pin);
}

for (const pkg of PACKAGES) {
  const key = normalizeURL(pkg.repositoryURL);
  const pin = pinsByURL.get(key);
  if (!pin) {
    errors.push(
      `Package "${pkg.name}" (${pkg.repositoryURL}) is declared in ` +
        "PACKAGES (ios-native/scripts/generate-pbxproj.mjs) but has no " +
        "matching pin in Package.resolved.\n" +
        FIX_HINT,
    );
    continue;
  }
  const version = pin.state?.version;
  if (!version) {
    errors.push(
      `Package "${pkg.name}" is pinned to a branch or revision (no ` +
        "version) in Package.resolved. PACKAGES requires version " +
        `>= ${pkg.minVersion}. Re-pin to a tagged release.\n${FIX_HINT}`,
    );
    continue;
  }
  if (compareVersions(version, pkg.minVersion) < 0) {
    errors.push(
      `Package "${pkg.name}" is resolved to ${version} in ` +
        `Package.resolved, which is below the minVersion ${pkg.minVersion} ` +
        "declared in PACKAGES (ios-native/scripts/generate-pbxproj.mjs).\n" +
        FIX_HINT,
    );
  }
}

if (errors.length > 0) {
  fail(errors);
}

console.log(
  "[check-package-resolved] OK — " +
    `${PACKAGES.length} package(s) match Package.resolved.`,
);
