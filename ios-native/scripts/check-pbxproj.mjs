#!/usr/bin/env node
// CI check: fails if `ios-native/CommandComms.xcodeproj/project.pbxproj` is
// out of date relative to `generate-pbxproj.mjs` or if any Swift source under
// `ios-native/CommandComms/` is missing from the script's GROUPS inventory.
//
// Run locally with:
//   node ios-native/scripts/check-pbxproj.mjs
//
// To fix a failure:
//   1. Add the new .swift file to the appropriate GROUPS entry in
//      ios-native/scripts/generate-pbxproj.mjs.
//   2. Re-run `node ios-native/scripts/generate-pbxproj.mjs`.
//   3. Commit the regenerated project.pbxproj.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import {
  GROUPS,
  SOURCE_ROOT,
  PBXPROJ_PATH,
  build,
  lint,
} from "./generate-pbxproj.mjs";

const errors = [];

// 1. Walk CommandComms/ for any .swift file not declared in GROUPS.
const declared = new Set();
for (const g of GROUPS) {
  for (const f of g.files) {
    if (f.endsWith(".swift")) {
      declared.add(join(g.path, f).split(sep).join("/"));
    }
  }
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(p));
    } else if (entry.isFile() && entry.name.endsWith(".swift")) {
      out.push(p);
    }
  }
  return out;
}

const onDisk = walk(SOURCE_ROOT).map((p) =>
  relative(SOURCE_ROOT, p).split(sep).join("/"),
);

const missing = onDisk.filter((p) => !declared.has(p));
if (missing.length > 0) {
  errors.push(
    "The following Swift sources exist on disk but are NOT declared in " +
      "GROUPS in ios-native/scripts/generate-pbxproj.mjs:\n" +
      missing.map((p) => `  - CommandComms/${p}`).join("\n") +
      "\nAdd them to the matching GROUPS entry and re-run the generator.",
  );
}

// 2. Regenerate the pbxproj in memory (no disk write) and compare to the
//    committed copy. A mismatch means either the committed file was hand
//    edited, or someone forgot to re-run the generator after editing GROUPS.
const generated = build();
lint(generated);
const committed = readFileSync(PBXPROJ_PATH, "utf8");
if (generated !== committed) {
  errors.push(
    `Committed ${relative(process.cwd(), PBXPROJ_PATH)} is out of date or ` +
      "was hand-edited. Run:\n" +
      "  node ios-native/scripts/generate-pbxproj.mjs\n" +
      "and commit the regenerated file.",
  );
}

if (errors.length > 0) {
  for (const e of errors) {
    console.error("\n[check-pbxproj] " + e);
  }
  process.exit(1);
}

console.log("[check-pbxproj] OK — pbxproj matches generator and inventory is complete.");
