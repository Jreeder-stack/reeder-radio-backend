#!/usr/bin/env node
// Regenerates ios-native/CommandComms.xcodeproj/project.pbxproj from a
// declarative inventory. The project file is GENERATED — do not hand-edit.
// To add a Swift source: drop the .swift into the right folder under
// ios-native/CommandComms/, add it to GROUPS below, and re-run:
//
//   node ios-native/scripts/generate-pbxproj.mjs
//
// IDs are derived from sha1("<kind>:<key>") truncated to 24 uppercase hex
// chars, so re-running on an unchanged inventory produces a byte-identical
// pbxproj and no two distinct inventory entries can ever collide.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");        // ios-native/
const SOURCE_ROOT = join(PROJECT_ROOT, "CommandComms");
const PBXPROJ_PATH = join(
  PROJECT_ROOT,
  "CommandComms.xcodeproj",
  "project.pbxproj",
);

// ---------------------------------------------------------------------------
// Inventory: every Swift source and resource that ships in the app target.
// Folder layout under ios-native/CommandComms/ is the source of truth for
// the on-disk path; the `group` field controls only the Xcode Navigator.
// ---------------------------------------------------------------------------

const GROUPS = [
  {
    name: "App",
    path: "App",
    parent: "CommandComms",
    files: [
      "CommandCommsApp.swift",
      "AppState.swift",
      "MainShellView.swift",
    ],
  },
  {
    name: "Audio",
    path: "Audio",
    parent: "CommandComms",
    files: [
      "AudioCapture.swift",
      "AudioPlayback.swift",
      "AudioSessionManager.swift",
      "JitterBuffer.swift",
      "OpusCodec.swift",
      "RadioAudioEngine.swift",
      "RadioPacket.swift",
      "SignalQuality.swift",
      "UdpAudioTransport.swift",
    ],
  },
  {
    name: "Features",
    path: "Features",
    parent: "CommandComms",
    files: [],
    children: ["DeviceRegistration", "Location", "Login", "Radio", "Settings"],
  },
  {
    name: "DeviceRegistration",
    path: "Features/DeviceRegistration",
    parent: "Features",
    files: ["DeviceRegistrationView.swift"],
  },
  {
    name: "Location",
    path: "Features/Location",
    parent: "Features",
    files: ["LocationTracker.swift"],
  },
  {
    name: "Login",
    path: "Features/Login",
    parent: "Features",
    files: ["LoginView.swift", "LoginViewModel.swift"],
  },
  {
    name: "Radio",
    path: "Features/Radio",
    parent: "Features",
    files: ["RadioView.swift"],
  },
  {
    name: "Settings",
    path: "Features/Settings",
    parent: "Features",
    files: ["SettingsView.swift"],
  },
  {
    name: "Models",
    path: "Models",
    parent: "CommandComms",
    files: ["User.swift"],
  },
  {
    name: "Networking",
    path: "Networking",
    parent: "CommandComms",
    files: [
      "ApiClient.swift",
      "AuthService.swift",
      "MFiPTTAccessoryManager.swift",
      "PTTAccessoryModel.swift",
      "RadioConfigService.swift",
      "SignalingClient.swift",
    ],
  },
  {
    name: "Storage",
    path: "Storage",
    parent: "CommandComms",
    files: ["AppPreferences.swift", "KeychainStore.swift"],
  },
  {
    name: "Resources",
    path: "Resources",
    parent: "CommandComms",
    files: ["Assets.xcassets", "Info.plist"],
  },
];

// ---------------------------------------------------------------------------
// SPM dependencies — must match the versions actually resolved in
// Package.resolved. Update both files together.
// ---------------------------------------------------------------------------

const PACKAGES = [
  {
    name: "socket.io-client-swift",
    repositoryURL: "https://github.com/socketio/socket.io-client-swift",
    minVersion: "16.1.0",
    products: ["SocketIO"],
  },
  {
    name: "KeychainAccess",
    repositoryURL: "https://github.com/kishikawakatsumi/KeychainAccess",
    minVersion: "4.2.2",
    products: ["KeychainAccess"],
  },
  {
    name: "swift-opus",
    repositoryURL: "https://github.com/alta/swift-opus.git",
    minVersion: "0.1.0",
    products: ["Opus"],
  },
];

// ---------------------------------------------------------------------------
// Deterministic ID helper: sha1("<kind>:<key>") -> first 24 uppercase hex.
// `kind` namespaces FileReference/BuildFile/Group/etc so the same key in
// different roles never collides.
// ---------------------------------------------------------------------------

function id(kind, key) {
  const h = createHash("sha1").update(`${kind}:${key}`).digest("hex");
  return h.slice(0, 24).toUpperCase();
}

// ---------------------------------------------------------------------------
// File classification
// ---------------------------------------------------------------------------

function fileTypeFor(name) {
  if (name.endsWith(".swift")) return "sourcecode.swift";
  if (name.endsWith(".xcassets")) return "folder.assetcatalog";
  if (name === "Info.plist" || name.endsWith(".plist")) return "text.plist.xml";
  throw new Error(`Unknown file type for ${name}`);
}

function isSource(name) {
  return name.endsWith(".swift");
}

function isResource(name) {
  // Info.plist is referenced via INFOPLIST_FILE only, never copied as a
  // resource (that's what causes the duplicate-output error).
  return name.endsWith(".xcassets");
}

// Validate that every declared file actually exists on disk so we fail
// loudly instead of producing a project that points at ghost files.
function validateInventory() {
  for (const g of GROUPS) {
    for (const f of g.files) {
      const p = join(SOURCE_ROOT, g.path, f);
      try {
        statSync(p);
      } catch (e) {
        throw new Error(`Missing inventory file: ${p}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// pbxproj emission
// ---------------------------------------------------------------------------

const PROJECT_ID = id("project", "CommandComms");
const MAIN_GROUP_ID = id("group", "<root>");
const PRODUCTS_GROUP_ID = id("group", "Products");
const FRAMEWORKS_GROUP_ID = id("group", "Frameworks");
const TARGET_ID = id("target", "CommandComms");
const PRODUCT_REF_ID = id("product", "CommandComms.app");
const SOURCES_PHASE_ID = id("phase", "Sources");
const FRAMEWORKS_PHASE_ID = id("phase", "Frameworks");
const RESOURCES_PHASE_ID = id("phase", "Resources");
const PROJECT_CFG_LIST_ID = id("cfglist", "project");
const TARGET_CFG_LIST_ID = id("cfglist", "target");
const PROJECT_DEBUG_ID = id("cfg", "project/Debug");
const PROJECT_RELEASE_ID = id("cfg", "project/Release");
const TARGET_DEBUG_ID = id("cfg", "target/Debug");
const TARGET_RELEASE_ID = id("cfg", "target/Release");

function fileRefId(group, name) {
  return id("fileref", `${group}/${name}`);
}
function buildFileId(group, name) {
  return id("buildfile", `${group}/${name}`);
}
function groupId(name) {
  return id("group", name);
}
function pkgRefId(name) {
  return id("pkgref", name);
}
function pkgProductId(name, product) {
  return id("pkgproduct", `${name}/${product}`);
}
function pkgBuildFileId(product) {
  return id("buildfile", `pkg/${product}`);
}

function lines(arr) {
  return arr.filter((x) => x !== "" && x !== null && x !== undefined).join("\n");
}

function emitBuildFiles() {
  const out = [];
  for (const g of GROUPS) {
    for (const f of g.files) {
      const phase = isSource(f)
        ? "Sources"
        : isResource(f)
          ? "Resources"
          : null;
      if (!phase) continue;
      out.push(
        `\t\t${buildFileId(g.path, f)} /* ${f} in ${phase} */ = {isa = PBXBuildFile; fileRef = ${fileRefId(g.path, f)} /* ${f} */; };`,
      );
    }
  }
  for (const p of PACKAGES) {
    for (const prod of p.products) {
      out.push(
        `\t\t${pkgBuildFileId(prod)} /* ${prod} in Frameworks */ = {isa = PBXBuildFile; productRef = ${pkgProductId(p.name, prod)} /* ${prod} */; };`,
      );
    }
  }
  out.sort();
  return lines([
    "/* Begin PBXBuildFile section */",
    ...out,
    "/* End PBXBuildFile section */",
  ]);
}

function emitFileReferences() {
  const out = [];
  out.push(
    `\t\t${PRODUCT_REF_ID} /* CommandComms.app */ = {isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = CommandComms.app; sourceTree = BUILT_PRODUCTS_DIR; };`,
  );
  for (const g of GROUPS) {
    for (const f of g.files) {
      out.push(
        `\t\t${fileRefId(g.path, f)} /* ${f} */ = {isa = PBXFileReference; lastKnownFileType = ${fileTypeFor(f)}; path = ${f}; sourceTree = "<group>"; };`,
      );
    }
  }
  out.sort();
  return lines([
    "/* Begin PBXFileReference section */",
    ...out,
    "/* End PBXFileReference section */",
  ]);
}

function emitFrameworksPhase() {
  const files = PACKAGES.flatMap((p) =>
    p.products.map(
      (prod) =>
        `\t\t\t\t${pkgBuildFileId(prod)} /* ${prod} in Frameworks */,`,
    ),
  );
  return lines([
    "/* Begin PBXFrameworksBuildPhase section */",
    `\t\t${FRAMEWORKS_PHASE_ID} /* Frameworks */ = {`,
    "\t\t\tisa = PBXFrameworksBuildPhase;",
    "\t\t\tbuildActionMask = 2147483647;",
    "\t\t\tfiles = (",
    ...files,
    "\t\t\t);",
    "\t\t\trunOnlyForDeploymentPostprocessing = 0;",
    "\t\t};",
    "/* End PBXFrameworksBuildPhase section */",
  ]);
}

function emitGroups() {
  const out = [];

  // Root main group
  out.push(
    lines([
      `\t\t${MAIN_GROUP_ID} = {`,
      "\t\t\tisa = PBXGroup;",
      "\t\t\tchildren = (",
      `\t\t\t\t${groupId("CommandComms")} /* CommandComms */,`,
      `\t\t\t\t${PRODUCTS_GROUP_ID} /* Products */,`,
      `\t\t\t\t${FRAMEWORKS_GROUP_ID} /* Frameworks */,`,
      "\t\t\t);",
      '\t\t\tsourceTree = "<group>";',
      "\t\t};",
    ]),
  );

  // Products group
  out.push(
    lines([
      `\t\t${PRODUCTS_GROUP_ID} /* Products */ = {`,
      "\t\t\tisa = PBXGroup;",
      "\t\t\tchildren = (",
      `\t\t\t\t${PRODUCT_REF_ID} /* CommandComms.app */,`,
      "\t\t\t);",
      "\t\t\tname = Products;",
      '\t\t\tsourceTree = "<group>";',
      "\t\t};",
    ]),
  );

  // Frameworks group (empty — SPM products are attached via package refs)
  out.push(
    lines([
      `\t\t${FRAMEWORKS_GROUP_ID} /* Frameworks */ = {`,
      "\t\t\tisa = PBXGroup;",
      "\t\t\tchildren = (",
      "\t\t\t);",
      "\t\t\tname = Frameworks;",
      '\t\t\tsourceTree = "<group>";',
      "\t\t};",
    ]),
  );

  // Top-level CommandComms group: lists each top-level child group.
  const topLevelGroupNames = GROUPS.filter((g) => g.parent === "CommandComms").map(
    (g) => g.name,
  );
  out.push(
    lines([
      `\t\t${groupId("CommandComms")} /* CommandComms */ = {`,
      "\t\t\tisa = PBXGroup;",
      "\t\t\tchildren = (",
      ...topLevelGroupNames.map(
        (n) => `\t\t\t\t${groupId(n)} /* ${n} */,`,
      ),
      "\t\t\t);",
      "\t\t\tpath = CommandComms;",
      '\t\t\tsourceTree = "<group>";',
      "\t\t};",
    ]),
  );

  // Each declared group
  for (const g of GROUPS) {
    const childGroups = g.children ?? [];
    const fileChildren = g.files.map(
      (f) => `\t\t\t\t${fileRefId(g.path, f)} /* ${f} */,`,
    );
    const groupChildren = childGroups.map(
      (cn) => `\t\t\t\t${groupId(cn)} /* ${cn} */,`,
    );
    out.push(
      lines([
        `\t\t${groupId(g.name)} /* ${g.name} */ = {`,
        "\t\t\tisa = PBXGroup;",
        "\t\t\tchildren = (",
        ...groupChildren,
        ...fileChildren,
        "\t\t\t);",
        // Use just the leaf segment; nested groups already pin parent path.
        `\t\t\tpath = ${g.name};`,
        '\t\t\tsourceTree = "<group>";',
        "\t\t};",
      ]),
    );
  }

  return lines([
    "/* Begin PBXGroup section */",
    ...out,
    "/* End PBXGroup section */",
  ]);
}

function emitNativeTarget() {
  return lines([
    "/* Begin PBXNativeTarget section */",
    `\t\t${TARGET_ID} /* CommandComms */ = {`,
    "\t\t\tisa = PBXNativeTarget;",
    `\t\t\tbuildConfigurationList = ${TARGET_CFG_LIST_ID} /* Build configuration list for PBXNativeTarget "CommandComms" */;`,
    "\t\t\tbuildPhases = (",
    `\t\t\t\t${SOURCES_PHASE_ID} /* Sources */,`,
    `\t\t\t\t${FRAMEWORKS_PHASE_ID} /* Frameworks */,`,
    `\t\t\t\t${RESOURCES_PHASE_ID} /* Resources */,`,
    "\t\t\t);",
    "\t\t\tbuildRules = (",
    "\t\t\t);",
    "\t\t\tdependencies = (",
    "\t\t\t);",
    "\t\t\tname = CommandComms;",
    "\t\t\tpackageProductDependencies = (",
    ...PACKAGES.flatMap((p) =>
      p.products.map(
        (prod) =>
          `\t\t\t\t${pkgProductId(p.name, prod)} /* ${prod} */,`,
      ),
    ),
    "\t\t\t);",
    "\t\t\tproductName = CommandComms;",
    `\t\t\tproductReference = ${PRODUCT_REF_ID} /* CommandComms.app */;`,
    '\t\t\tproductType = "com.apple.product-type.application";',
    "\t\t};",
    "/* End PBXNativeTarget section */",
  ]);
}

function emitProject() {
  return lines([
    "/* Begin PBXProject section */",
    `\t\t${PROJECT_ID} /* Project object */ = {`,
    "\t\t\tisa = PBXProject;",
    "\t\t\tattributes = {",
    "\t\t\t\tBuildIndependentTargetsInParallel = 1;",
    "\t\t\t\tLastSwiftUpdateCheck = 1500;",
    "\t\t\t\tLastUpgradeCheck = 1500;",
    "\t\t\t\tTargetAttributes = {",
    `\t\t\t\t\t${TARGET_ID} = {`,
    "\t\t\t\t\t\tCreatedOnToolsVersion = 15.0;",
    "\t\t\t\t\t};",
    "\t\t\t\t};",
    "\t\t\t};",
    `\t\t\tbuildConfigurationList = ${PROJECT_CFG_LIST_ID} /* Build configuration list for PBXProject "CommandComms" */;`,
    '\t\t\tcompatibilityVersion = "Xcode 14.0";',
    "\t\t\tdevelopmentRegion = en;",
    "\t\t\thasScannedForEncodings = 0;",
    "\t\t\tknownRegions = (",
    "\t\t\t\ten,",
    "\t\t\t\tBase,",
    "\t\t\t);",
    `\t\t\tmainGroup = ${MAIN_GROUP_ID};`,
    "\t\t\tpackageReferences = (",
    ...PACKAGES.map(
      (p) =>
        `\t\t\t\t${pkgRefId(p.name)} /* XCRemoteSwiftPackageReference "${p.name}" */,`,
    ),
    "\t\t\t);",
    `\t\t\tproductRefGroup = ${PRODUCTS_GROUP_ID} /* Products */;`,
    '\t\t\tprojectDirPath = "";',
    '\t\t\tprojectRoot = "";',
    "\t\t\ttargets = (",
    `\t\t\t\t${TARGET_ID} /* CommandComms */,`,
    "\t\t\t);",
    "\t\t};",
    "/* End PBXProject section */",
  ]);
}

function emitResourcesPhase() {
  const resourceFiles = [];
  for (const g of GROUPS) {
    for (const f of g.files) {
      if (isResource(f)) {
        resourceFiles.push(
          `\t\t\t\t${buildFileId(g.path, f)} /* ${f} in Resources */,`,
        );
      }
    }
  }
  return lines([
    "/* Begin PBXResourcesBuildPhase section */",
    `\t\t${RESOURCES_PHASE_ID} /* Resources */ = {`,
    "\t\t\tisa = PBXResourcesBuildPhase;",
    "\t\t\tbuildActionMask = 2147483647;",
    "\t\t\tfiles = (",
    ...resourceFiles,
    "\t\t\t);",
    "\t\t\trunOnlyForDeploymentPostprocessing = 0;",
    "\t\t};",
    "/* End PBXResourcesBuildPhase section */",
  ]);
}

function emitSourcesPhase() {
  const files = [];
  for (const g of GROUPS) {
    for (const f of g.files) {
      if (isSource(f)) {
        files.push(
          `\t\t\t\t${buildFileId(g.path, f)} /* ${f} in Sources */,`,
        );
      }
    }
  }
  files.sort();
  return lines([
    "/* Begin PBXSourcesBuildPhase section */",
    `\t\t${SOURCES_PHASE_ID} /* Sources */ = {`,
    "\t\t\tisa = PBXSourcesBuildPhase;",
    "\t\t\tbuildActionMask = 2147483647;",
    "\t\t\tfiles = (",
    ...files,
    "\t\t\t);",
    "\t\t\trunOnlyForDeploymentPostprocessing = 0;",
    "\t\t};",
    "/* End PBXSourcesBuildPhase section */",
  ]);
}

const PROJECT_DEBUG_SETTINGS = `\t\t\t\tALWAYS_SEARCH_USER_PATHS = NO;
\t\t\t\tASSETCATALOG_COMPILER_GENERATE_SWIFT_ASSET_SYMBOL_EXTENSIONS = YES;
\t\t\t\tCLANG_ANALYZER_NONNULL = YES;
\t\t\t\tCLANG_ANALYZER_NUMBER_OBJECT_CONVERSION = YES_AGGRESSIVE;
\t\t\t\tCLANG_CXX_LANGUAGE_STANDARD = "gnu++20";
\t\t\t\tCLANG_ENABLE_MODULES = YES;
\t\t\t\tCLANG_ENABLE_OBJC_ARC = YES;
\t\t\t\tCLANG_ENABLE_OBJC_WEAK = YES;
\t\t\t\tCLANG_WARN_BLOCK_CAPTURE_AUTORELEASING = YES;
\t\t\t\tCLANG_WARN_BOOL_CONVERSION = YES;
\t\t\t\tCLANG_WARN_COMMA = YES;
\t\t\t\tCLANG_WARN_CONSTANT_CONVERSION = YES;
\t\t\t\tCLANG_WARN_DEPRECATED_OBJC_IMPLEMENTATIONS = YES;
\t\t\t\tCLANG_WARN_DIRECT_OBJC_ISA_USAGE = YES_ERROR;
\t\t\t\tCLANG_WARN_DOCUMENTATION_COMMENTS = YES;
\t\t\t\tCLANG_WARN_EMPTY_BODY = YES;
\t\t\t\tCLANG_WARN_ENUM_CONVERSION = YES;
\t\t\t\tCLANG_WARN_INFINITE_RECURSION = YES;
\t\t\t\tCLANG_WARN_INT_CONVERSION = YES;
\t\t\t\tCLANG_WARN_NON_LITERAL_NULL_CONVERSION = YES;
\t\t\t\tCLANG_WARN_OBJC_IMPLICIT_RETAIN_SELF = YES;
\t\t\t\tCLANG_WARN_OBJC_LITERAL_CONVERSION = YES;
\t\t\t\tCLANG_WARN_OBJC_ROOT_CLASS = YES_ERROR;
\t\t\t\tCLANG_WARN_QUOTED_INCLUDE_IN_FRAMEWORK_HEADER = YES;
\t\t\t\tCLANG_WARN_RANGE_LOOP_ANALYSIS = YES;
\t\t\t\tCLANG_WARN_STRICT_PROTOTYPES = YES;
\t\t\t\tCLANG_WARN_SUSPICIOUS_MOVE = YES;
\t\t\t\tCLANG_WARN_UNGUARDED_AVAILABILITY = YES_AGGRESSIVE;
\t\t\t\tCLANG_WARN_UNREACHABLE_CODE = YES;
\t\t\t\tCLANG_WARN__DUPLICATE_METHOD_MATCH = YES;
\t\t\t\tCOPY_PHASE_STRIP = NO;
\t\t\t\tDEBUG_INFORMATION_FORMAT = dwarf;
\t\t\t\tENABLE_STRICT_OBJC_MSGSEND = YES;
\t\t\t\tENABLE_TESTABILITY = YES;
\t\t\t\tENABLE_USER_SCRIPT_SANDBOXING = YES;
\t\t\t\tGCC_C_LANGUAGE_STANDARD = gnu17;
\t\t\t\tGCC_DYNAMIC_NO_PIC = NO;
\t\t\t\tGCC_NO_COMMON_BLOCKS = YES;
\t\t\t\tGCC_OPTIMIZATION_LEVEL = 0;
\t\t\t\tGCC_PREPROCESSOR_DEFINITIONS = (
\t\t\t\t\t"DEBUG=1",
\t\t\t\t\t"$(inherited)",
\t\t\t\t);
\t\t\t\tGCC_WARN_64_TO_32_BIT_CONVERSION = YES;
\t\t\t\tGCC_WARN_ABOUT_RETURN_TYPE = YES_ERROR;
\t\t\t\tGCC_WARN_UNDECLARED_SELECTOR = YES;
\t\t\t\tGCC_WARN_UNINITIALIZED_AUTOS = YES_AGGRESSIVE;
\t\t\t\tGCC_WARN_UNUSED_FUNCTION = YES;
\t\t\t\tGCC_WARN_UNUSED_VARIABLE = YES;
\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = 17.0;
\t\t\t\tLOCALIZATION_PREFERS_STRING_CATALOGS = YES;
\t\t\t\tMTL_ENABLE_DEBUG_INFO = INCLUDE_SOURCE;
\t\t\t\tMTL_FAST_MATH = YES;
\t\t\t\tONLY_ACTIVE_ARCH = YES;
\t\t\t\tSDKROOT = iphoneos;
\t\t\t\tSWIFT_ACTIVE_COMPILATION_CONDITIONS = "DEBUG $(inherited)";
\t\t\t\tSWIFT_OPTIMIZATION_LEVEL = "-Onone";`;

const PROJECT_RELEASE_SETTINGS = `\t\t\t\tALWAYS_SEARCH_USER_PATHS = NO;
\t\t\t\tASSETCATALOG_COMPILER_GENERATE_SWIFT_ASSET_SYMBOL_EXTENSIONS = YES;
\t\t\t\tCLANG_ANALYZER_NONNULL = YES;
\t\t\t\tCLANG_ANALYZER_NUMBER_OBJECT_CONVERSION = YES_AGGRESSIVE;
\t\t\t\tCLANG_CXX_LANGUAGE_STANDARD = "gnu++20";
\t\t\t\tCLANG_ENABLE_MODULES = YES;
\t\t\t\tCLANG_ENABLE_OBJC_ARC = YES;
\t\t\t\tCLANG_ENABLE_OBJC_WEAK = YES;
\t\t\t\tCLANG_WARN_BLOCK_CAPTURE_AUTORELEASING = YES;
\t\t\t\tCLANG_WARN_BOOL_CONVERSION = YES;
\t\t\t\tCLANG_WARN_COMMA = YES;
\t\t\t\tCLANG_WARN_CONSTANT_CONVERSION = YES;
\t\t\t\tCLANG_WARN_DEPRECATED_OBJC_IMPLEMENTATIONS = YES;
\t\t\t\tCLANG_WARN_DIRECT_OBJC_ISA_USAGE = YES_ERROR;
\t\t\t\tCLANG_WARN_DOCUMENTATION_COMMENTS = YES;
\t\t\t\tCLANG_WARN_EMPTY_BODY = YES;
\t\t\t\tCLANG_WARN_ENUM_CONVERSION = YES;
\t\t\t\tCLANG_WARN_INFINITE_RECURSION = YES;
\t\t\t\tCLANG_WARN_INT_CONVERSION = YES;
\t\t\t\tCLANG_WARN_NON_LITERAL_NULL_CONVERSION = YES;
\t\t\t\tCLANG_WARN_OBJC_IMPLICIT_RETAIN_SELF = YES;
\t\t\t\tCLANG_WARN_OBJC_LITERAL_CONVERSION = YES;
\t\t\t\tCLANG_WARN_OBJC_ROOT_CLASS = YES_ERROR;
\t\t\t\tCLANG_WARN_QUOTED_INCLUDE_IN_FRAMEWORK_HEADER = YES;
\t\t\t\tCLANG_WARN_RANGE_LOOP_ANALYSIS = YES;
\t\t\t\tCLANG_WARN_STRICT_PROTOTYPES = YES;
\t\t\t\tCLANG_WARN_SUSPICIOUS_MOVE = YES;
\t\t\t\tCLANG_WARN_UNGUARDED_AVAILABILITY = YES_AGGRESSIVE;
\t\t\t\tCLANG_WARN_UNREACHABLE_CODE = YES;
\t\t\t\tCLANG_WARN__DUPLICATE_METHOD_MATCH = YES;
\t\t\t\tCOPY_PHASE_STRIP = NO;
\t\t\t\tDEBUG_INFORMATION_FORMAT = "dwarf-with-dsym";
\t\t\t\tENABLE_NS_ASSERTIONS = NO;
\t\t\t\tENABLE_STRICT_OBJC_MSGSEND = YES;
\t\t\t\tENABLE_USER_SCRIPT_SANDBOXING = YES;
\t\t\t\tGCC_C_LANGUAGE_STANDARD = gnu17;
\t\t\t\tGCC_NO_COMMON_BLOCKS = YES;
\t\t\t\tGCC_WARN_64_TO_32_BIT_CONVERSION = YES;
\t\t\t\tGCC_WARN_ABOUT_RETURN_TYPE = YES_ERROR;
\t\t\t\tGCC_WARN_UNDECLARED_SELECTOR = YES;
\t\t\t\tGCC_WARN_UNINITIALIZED_AUTOS = YES_AGGRESSIVE;
\t\t\t\tGCC_WARN_UNUSED_FUNCTION = YES;
\t\t\t\tGCC_WARN_UNUSED_VARIABLE = YES;
\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = 17.0;
\t\t\t\tLOCALIZATION_PREFERS_STRING_CATALOGS = YES;
\t\t\t\tMTL_ENABLE_DEBUG_INFO = NO;
\t\t\t\tMTL_FAST_MATH = YES;
\t\t\t\tSDKROOT = iphoneos;
\t\t\t\tSWIFT_COMPILATION_MODE = wholemodule;
\t\t\t\tVALIDATE_PRODUCT = YES;`;

const TARGET_SETTINGS = `\t\t\t\tASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;
\t\t\t\tASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME = AccentColor;
\t\t\t\tCODE_SIGN_STYLE = Automatic;
\t\t\t\tCURRENT_PROJECT_VERSION = 1;
\t\t\t\tDEVELOPMENT_ASSET_PATHS = "";
\t\t\t\tENABLE_PREVIEWS = YES;
\t\t\t\tGENERATE_INFOPLIST_FILE = NO;
\t\t\t\tINFOPLIST_FILE = CommandComms/Resources/Info.plist;
\t\t\t\tLD_RUNPATH_SEARCH_PATHS = (
\t\t\t\t\t"$(inherited)",
\t\t\t\t\t"@executable_path/Frameworks",
\t\t\t\t);
\t\t\t\tMARKETING_VERSION = 1.0;
\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = com.reedersystems.commandcomms;
\t\t\t\tPRODUCT_NAME = "$(TARGET_NAME)";
\t\t\t\tSWIFT_EMIT_LOC_STRINGS = YES;
\t\t\t\tSWIFT_VERSION = 5.0;
\t\t\t\tTARGETED_DEVICE_FAMILY = "1,2";`;

function emitBuildConfigs() {
  return lines([
    "/* Begin XCBuildConfiguration section */",
    `\t\t${PROJECT_DEBUG_ID} /* Debug */ = {`,
    "\t\t\tisa = XCBuildConfiguration;",
    "\t\t\tbuildSettings = {",
    PROJECT_DEBUG_SETTINGS,
    "\t\t\t};",
    "\t\t\tname = Debug;",
    "\t\t};",
    `\t\t${PROJECT_RELEASE_ID} /* Release */ = {`,
    "\t\t\tisa = XCBuildConfiguration;",
    "\t\t\tbuildSettings = {",
    PROJECT_RELEASE_SETTINGS,
    "\t\t\t};",
    "\t\t\tname = Release;",
    "\t\t};",
    `\t\t${TARGET_DEBUG_ID} /* Debug */ = {`,
    "\t\t\tisa = XCBuildConfiguration;",
    "\t\t\tbuildSettings = {",
    TARGET_SETTINGS,
    "\t\t\t};",
    "\t\t\tname = Debug;",
    "\t\t};",
    `\t\t${TARGET_RELEASE_ID} /* Release */ = {`,
    "\t\t\tisa = XCBuildConfiguration;",
    "\t\t\tbuildSettings = {",
    TARGET_SETTINGS,
    "\t\t\t};",
    "\t\t\tname = Release;",
    "\t\t};",
    "/* End XCBuildConfiguration section */",
  ]);
}

function emitConfigurationLists() {
  return lines([
    "/* Begin XCConfigurationList section */",
    `\t\t${PROJECT_CFG_LIST_ID} /* Build configuration list for PBXProject "CommandComms" */ = {`,
    "\t\t\tisa = XCConfigurationList;",
    "\t\t\tbuildConfigurations = (",
    `\t\t\t\t${PROJECT_DEBUG_ID} /* Debug */,`,
    `\t\t\t\t${PROJECT_RELEASE_ID} /* Release */,`,
    "\t\t\t);",
    "\t\t\tdefaultConfigurationIsVisible = 0;",
    "\t\t\tdefaultConfigurationName = Release;",
    "\t\t};",
    `\t\t${TARGET_CFG_LIST_ID} /* Build configuration list for PBXNativeTarget "CommandComms" */ = {`,
    "\t\t\tisa = XCConfigurationList;",
    "\t\t\tbuildConfigurations = (",
    `\t\t\t\t${TARGET_DEBUG_ID} /* Debug */,`,
    `\t\t\t\t${TARGET_RELEASE_ID} /* Release */,`,
    "\t\t\t);",
    "\t\t\tdefaultConfigurationIsVisible = 0;",
    "\t\t\tdefaultConfigurationName = Release;",
    "\t\t};",
    "/* End XCConfigurationList section */",
  ]);
}

function emitPackageReferences() {
  const out = [];
  for (const p of PACKAGES) {
    out.push(
      lines([
        `\t\t${pkgRefId(p.name)} /* XCRemoteSwiftPackageReference "${p.name}" */ = {`,
        "\t\t\tisa = XCRemoteSwiftPackageReference;",
        `\t\t\trepositoryURL = "${p.repositoryURL}";`,
        "\t\t\trequirement = {",
        "\t\t\t\tkind = upToNextMajorVersion;",
        `\t\t\t\tminimumVersion = ${p.minVersion};`,
        "\t\t\t};",
        "\t\t};",
      ]),
    );
  }
  return lines([
    "/* Begin XCRemoteSwiftPackageReference section */",
    ...out,
    "/* End XCRemoteSwiftPackageReference section */",
  ]);
}

function emitPackageProductDependencies() {
  const out = [];
  for (const p of PACKAGES) {
    for (const prod of p.products) {
      out.push(
        lines([
          `\t\t${pkgProductId(p.name, prod)} /* ${prod} */ = {`,
          "\t\t\tisa = XCSwiftPackageProductDependency;",
          `\t\t\tpackage = ${pkgRefId(p.name)} /* XCRemoteSwiftPackageReference "${p.name}" */;`,
          `\t\t\tproductName = ${prod};`,
          "\t\t};",
        ]),
      );
    }
  }
  return lines([
    "/* Begin XCSwiftPackageProductDependency section */",
    ...out,
    "/* End XCSwiftPackageProductDependency section */",
  ]);
}

function build() {
  validateInventory();
  return lines([
    "// !$*UTF8*$!",
    "{",
    "\tarchiveVersion = 1;",
    "\tclasses = {",
    "\t};",
    "\tobjectVersion = 56;",
    "\tobjects = {",
    "",
    emitBuildFiles(),
    "",
    emitFileReferences(),
    "",
    emitFrameworksPhase(),
    "",
    emitGroups(),
    "",
    emitNativeTarget(),
    "",
    emitProject(),
    "",
    emitResourcesPhase(),
    "",
    emitSourcesPhase(),
    "",
    emitBuildConfigs(),
    "",
    emitConfigurationLists(),
    "",
    emitPackageReferences(),
    "",
    emitPackageProductDependencies(),
    "\t};",
    `\trootObject = ${PROJECT_ID} /* Project object */;`,
    "}",
    "",
  ]);
}

// ---------------------------------------------------------------------------
// Self-lint: every BuildFile must reference an existing FileReference; every
// FileReference ID must be unique; no path field may escape the source root.
// ---------------------------------------------------------------------------

function lint(text) {
  const fileRefIds = new Set();
  const buildFileRefs = new Set();
  const dupes = [];

  const fileRefRe =
    /^\s*([0-9A-F]{24}) \/\* [^*]+ \*\/ = \{isa = PBXFileReference;[^}]*\};$/gm;
  let m;
  while ((m = fileRefRe.exec(text))) {
    if (fileRefIds.has(m[1])) dupes.push(m[1]);
    fileRefIds.add(m[1]);
  }
  if (dupes.length > 0) {
    throw new Error(`Duplicate PBXFileReference IDs: ${dupes.join(", ")}`);
  }

  const buildFileRe =
    /isa = PBXBuildFile;\s+fileRef = ([0-9A-F]{24})/g;
  while ((m = buildFileRe.exec(text))) {
    buildFileRefs.add(m[1]);
  }
  for (const ref of buildFileRefs) {
    if (!fileRefIds.has(ref)) {
      throw new Error(`PBXBuildFile references missing fileRef ${ref}`);
    }
  }

  // No path = ../something or absolute path.
  const pathRe = /^\s*path = ([^;]+);/gm;
  while ((m = pathRe.exec(text))) {
    const p = m[1].replace(/^"|"$/g, "");
    if (p.startsWith("/") || p.startsWith("..") || p.includes("..")) {
      throw new Error(`Suspicious path escapes source root: ${p}`);
    }
  }

  if (text.includes("lastKnownFileType = folder;")) {
    throw new Error("Found a raw folder reference (lastKnownFileType = folder)");
  }
  if (!text.includes("INFOPLIST_FILE = CommandComms/Resources/Info.plist;")) {
    throw new Error("INFOPLIST_FILE setting missing");
  }
  if (text.includes("Info.plist in Resources")) {
    throw new Error(
      "Info.plist appears in a Resources phase — must be referenced via INFOPLIST_FILE only",
    );
  }
}

const out = build();
lint(out);
writeFileSync(PBXPROJ_PATH, out);
console.log(`Wrote ${PBXPROJ_PATH} (${out.length} bytes)`);
