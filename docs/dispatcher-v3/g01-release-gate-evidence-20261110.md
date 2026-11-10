# AI-DISP-V3-001 / G-01 release-gate evidence assessment

**Date:** 2026-11-10. **Status:** G-01 **[ ] NOT COMPLETE**. G-02 through G-04 also remain unchecked.
**Repository:** Jreeder-stack/reeder-radio-backend; branch `test/dispatcher-v3-01-01-baseline-20261028`; PR #163 draft, open, unmerged, and unmergeable.
**Validated V3 executable baseline:** `a21fb09b03a6bcd5658e1788375d8713d84ad642`.
**One-time qualification setup:** `6e17de8cb48f75cf5ad8e02f0479dde624b668a2` (only existing CI workflow altered).
**Scoped test-only corrections/qualification candidate:** `ab8c9f3c01f4c38e178f414d4901f6a656fcc0af`. No dispatcher runtime/source, radio, provider, CAD authorization, schema, transport, codec, firmware, or deployment code was changed by either G-01 commit.

## Verified CI: green work and remaining red conditions

GitHub [run 42891691309](https://github.com/Jreeder-stack/reeder-radio-backend/actions/runs/42891691309), Node **v20.20.2**, GitHub-hosted Linux, commit `ab8c9f3c01f4c38e178f414d4901f6a656fcc0af`:

| Job / scope | Result | Evidence |
| --- | --- | --- |
| V3 scoped regression job `130094189162` | **SUCCESS** | Full 683/683 V3, 72/72 synthetic acceptance, 81/81 PTT, 8/8 manager, 26/26 audit assertions, syntax and legacy-file checks |
| G-01 repository qualification job `130094188693` | **FAILURE overall** | 946/946 root Vitest tests across 90 files PASS; backend entrypoint syntax PASS; web client locked-dependency build PASS; desktop gateway tests 10/10 PASS; both iOS project inventory checks FAIL |

**Do not label the overall workflow green.** Both jobs must be reported separately. The G-01 job is red because of two independently recorded iOS project inventory failures, not because of failing V3/backend/web/desktop tests. These results do not prove an iOS Xcode build.

GitHub-uploaded evidence artifacts (GitHub-reported digests; neither ZIP independently downloaded/rehashed in this assessment):

- `dispatcher-v3-evidence-42891691309-1`, artifact `13798736397`, reported SHA-256 `b9713c6b9fb2f035c4a48af3d60c7dae8e142c8ad9693bd562a8f90db71e10f5`.
- `dispatcher-g01-full-repository-42891691309-1`, artifact `13798258516`, reported SHA-256 `fae8987c3f2a6baf73a10294f540a4e75bb73a7e3e3dfad71dff3abc4e96c0a6`.

## Exact commands and environment

The existing V3 workflow, using Node 20 and `npm ci`, ran:

```sh
node --check src/services/aiDispatcherRuntimeManager.js  # plus its listed V3/service boundary files
test ! -e src/services/commandMatcher.js                 # plus seven other removed-engine files and grep guard
npm test -- src/services/__tests__/pttIntakeAdapters.test.js src/services/__tests__/pttRuntimeRouting.test.js src/services/__tests__/signalingFloorIdentityHardening.test.js src/services/__tests__/audioRelaySiblingDeviceHardening.test.js src/services/__tests__/floorControlService.aiWatchdog.test.js --reporter=default --reporter=json --outputFile=reports/ptt-tests.json
npm test -- src/services/__tests__/dispatcherV3ManagerIntegration.test.js --reporter=default --reporter=json --outputFile=reports/v3-manager-integration.json
DISPATCHER_AUDIT_MODE=baseline DISPATCHER_AUDIT_REPORT=reports/dispatcher-audit-baseline.json npm run test:v3 -- --reporter=default --reporter=json --outputFile=reports/v3-tests.json
node scripts/dispatcher-v3-acceptance.mjs --synthetic
```

The added one-time G-01 job ran:

```sh
npm ci
npm test -- --reporter=default --reporter=json --outputFile=reports/g01-full-repository-tests.json
node --check src/server.js
node --check server.js
npm ci --prefix client
npm run build --prefix client
npm test --prefix desktop-app
node ios-native/scripts/check-pbxproj.mjs
node ios-native/scripts/check-package-resolved.mjs
```

No repository backend compilation script is defined; the Node server entrypoints passed syntax validation. The client uses its committed lockfile; no deploy or runtime startup was attempted.

## Seven pre-existing assertion mismatches reconciled without runtime changes

Initial G-01 [run 42890800309](https://github.com/Jreeder-stack/reeder-radio-backend/actions/runs/42890800309), `6e17de8`, had **939/946** root tests pass and seven failures in three existing files. The files and their implementation dependencies have identical Git blobs at the audited `main` base `c5ce5feed7a4feadb86ddca3d6d8c89e2c2f90fa`; these were not introduced by V3:

- Two `cadService.resolveUnitCurrentCall` assertions and four `cadService.statusCheckEndpoints` URL assertions compared a valid `URL` object directly to a string. Test-only normalization to `String(url)` preserves exact endpoint, escaped ID and body assertions.
- One `locationService.cadResolver` assertion expected the old plain road and state shape. Existing `normalizeAddressRecord()` intentionally preserves the named premise in the road/display text, with `postalState: 'PA'`, `state: null`, and a separate `streetAddress`. The test now asserts the full format and fields, not a weaker match.

These three test files alone were corrected in commit `ab8c9f3`. The complete subsequent root suite passed **946/946**. No CAD request or location formatter runtime code changed.

## Outstanding iOS and mobile evidence

Both iOS checks are failing for baseline issues untouched by V3:

1. `ios-native/scripts/check-pbxproj.mjs` reports four Swift files missing from the generator's `GROUPS`: `App/AppDelegate.swift`, `Features/Onboarding/PermissionsCoordinator.swift`, `Features/Onboarding/PermissionsOnboardingView.swift`, `Networking/PushNotificationService.swift`. The committed Xcode pbxproj is out of date.
2. `ios-native/scripts/check-package-resolved.mjs` reports missing `ios-native/CommandComms.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`.

No unrelated iOS project repair, Xcode compilation, or iOS field verification was authorized or performed here.

**Android build source equivalence:** candidate `ab8c9f3` and historical audited base `c5ce5fe` have identical `android-native/` Git subtree SHA `86d4ba54b4731d79639b09e71c08533f1a2e2d51`. Historical [Android build run 38101700470](https://github.com/Jreeder-stack/reeder-radio-backend/actions/runs/38101700470), October 11, 2026, succeeded for phone (job 114358790439) and bridge (job 114358790334). This is evidence of a successful build of **identical Android source**, not a new candidate-commit Android build or actual field/device compatibility. T320/SD7 and current newer-main/mobile integrations are not newly qualified.

## Legacy execution / implementation boundary

CI confirms the enumerated obsolete dispatcher engine files are absent, its explicit legacy environment reference grep passes, and the real runtime manager integration suite succeeds. Source review confirms `AIDispatcherRuntimeManager.startProfile()` constructs `V3LiveDispatcher`; retained `aiDispatchService.AIDispatcher` constructor throws rather than reviving the removed engine; existing legacy settings facade forwards to V3. A full cross-repository and alternate-entry reachability proof against newer `main` has not been performed.

Current source-defined operational limits are documented in the master checklist, including 64 process-global resident turns, eight resident per unit, eight STT preparation/four execution capacities, 60-second total turn deadline, bounded CAD and TTS stages, a 32-message outbound queue, and 30-second prompt answer lease. These are **source configuration**, not measured live guarantees.

## Gate disposition and next action

- **G-01 remains [ ]**, due to overall G-01 CI failure and unqualified iOS/mobile and newer-main/alternate-entry boundaries. Do not ignore red checks or call this a full green release.
- **G-02, G-03, G-04 remain [ ]**. No live provider, Command Link, real five-radio audio, costs/latency p50/p95, human pilot or rollback evidence.
- PR #163 remains draft/unmerged/unmergeable. No merge, rebase, deployment, restart, paid API call or production data change.
- **Next:** Determine whether iOS/native-client compilation is within the appropriate G-01 build scope; separately plan baseline iOS inventory repairs if required, then requalify. Independently review any remaining V3 startup/legacy references and record candidate-specific acceptance before checking G-01. Do not silently expand this V3-only qualification into mobile feature development.
