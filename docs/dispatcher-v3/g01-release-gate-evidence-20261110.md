# AI-DISP-V3-001 / G-01 release-gate evidence assessment

**Date:** 2026-11-10. **Current status:** G-01 **[x] BACKEND QUALIFIED** following newer-main reconciliation; G-02 through G-04 remain unchecked. Older failure sections are preserved as historical evidence; see final section.
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

## Additional G-01 safety blocker: legacy emergency HTTP ingress (read-only trace, November 10)

**Gate impact: G-01 remains [ ].** This is a distinct public-safety issue identified while checking alternate V3 entry paths. It is **source-confirmed/reachability-traced, not an exploited live system**. No fake emergency was sent to a real radio or CAD. No implementation or test repair is approved as part of this evidence-only assessment.

**Conditional source path:**

1. \`src/routes/index.js\` mounts \`dispatchRouter\` at \`/api/dispatch\`. The router's \`router.use(requireAuth)\` only requires an authenticated session (not a verified emergency device event).
2. \`src/routes/dispatchRouter.js\` exposes \`POST /notify-emergency\` to that session. \`src/controllers/dispatchController.js::notifyEmergency\` accepts requester-supplied \`channel\`, \`identity\` and \`active\`. It checks the legacy global AI enabled flag but **does not bind the emergency identity to the authenticated session or demand a trusted physical emergency signal**.
3. If active and a dispatcher can be found/started, this calls \`getDispatcher().aiService.handleEmergencySignal(identity, channel)\`. In \`src/services/aiDispatchService.js\` this compatibility method forwards directly to \`dispatcher.handleEmergencyStart(channel, unitId)\`. That method in \`src/dispatcher-v3/liveRuntime.js\` assumes the signal is hardware-origin and starts \`_startHardwareEmergency\`.
4. \`_startHardwareEmergency\` marks \`source:'hardware'\`, issues status checks and schedules escalation after unanswered prompts. \`_escalateEmergency\` can create a CAD emergency call, send on-air notices and page responding units. It must not be reachable merely through an HTTP client's unverified emergency claim.
5. The supported Socket.IO hardware-emergency event has a separate callback path via \`signalingService.onEmergencyStart\` into V3. The legacy HTTP path does **not** need to impersonate that callback to reach the hardware-emergency behavior.

**Cross-checks:** The full \`notifyEmergency\` body was compared byte-for-byte against the audited base \`c5ce5feed7a4feadb86ddca3d6d8c89e2c2f90fa\` and is unchanged there; this is a **pre-existing compatibility issue exposed by V3 routing**, not a new mutation introduced by G-01 test work. The current repository's documented \`docs/CAD_API_REFERENCE.md\` explicitly exposes \`POST /api/dispatch/notify-emergency\` with session-only auth and the same identity/channel/active body. A default-branch search found no first-party client call sites for the HTTP route beyond the route and API documentation; external consumer use is **not independently excluded**.

**Positive route evidence:** Normal \`src/server.js\` calls \`aiDispatcherRuntimeManager.initialize()\`. Its profile \`startProfile()\` instantiates \`V3LiveDispatcher\`, and the manager's trusted PTT callbacks resolve channel/center and route into that runtime. \`/api/admin/ai-dispatchers/*\` is admin-only. The legacy \`/api/admin/ai-dispatch\` settings facade delegates to the V3 manager. The legacy \`/api/dispatch/notify-ptt\` does bind an authenticated session's PTT identity, grant and correlated request to the V3 compatibility resolver. The old \`AIDispatcher\` class constructor throws and does not instantiate V1/V2. A separate \`npm run start:old\` script is present but is not the package's default startup; no revived V1/V2 dispatcher was found in its alternate server entrypoint during this inspection.

**Proposed bounded repair, subject to separate owner approval under AGENTS.md:** Eliminate the legacy HTTP endpoint's ability to synthesize a V3 hardware-emergency event from arbitrary request body fields. Do **not** weaken the authenticated actual-emergency callback, physical alert state, operator clearing, CAD verification or V3 lifecycle. Choose the endpoint's safe compatibility/error response after identifying any real legacy consumers. Guard the trust boundary at ingress, not by suppressing only final speech. Test authenticated impersonation, wrong channel/center, ordinary HTTP status reporting, correct legitimate physical emergency, repeated event, fail-closed unavailable signaling, restart and emergency preservation, with synthetic CAD and zero paid/live calls. Rerun the 946-case root, 683-case V3, 81 PTT, 8 manager, 26 audit and 72 acceptance suites plus applicable builds. The numbers above describe the preceding successful run, **not** a rerun after this finding.

**Owner-control boundary:** No runtime or test source was modified in response to this blocker. A material safety fix is a scope change requiring explicit approval before implementing. G-02 through G-04 remain untouched; no merge, rebase, deploy, restart or production changes.

### iOS applicability still unresolved

The two separate iOS project inventory failures are identical to known baseline defects and do not arise from changed V3 code. Backend/V3, web and desktop build/test evidence is green; Android phone/bridge evidence is from a successful build of the identical \`android-native/\` tree. Whether iOS compilation must be required for this particular backend/dispatcher G-01 gate has **not** been approved as an exclusion. Regardless, this emergency-ingress defect independently prevents G-01 acceptance.


## Approved G-01 emergency-ingress repair: scoped validation (November 10, 2026)

**Status:** Implementation and scoped synthetic regression validation **passed**. **G-01 itself remains [ ]** pending separate qualification decisions. The earlier section above is preserved as a historical pre-repair diagnosis, not a description of the current branch behavior.

Owner explicitly approved the narrow emergency-ingress repair. **Implementation commit:** `b1cab9645bc43d4464a2d3f0297560367b7c9717`. Five files changed: `src/controllers/dispatchController.js`, `src/services/aiDispatchService.js`, `src/services/__tests__/pttRuntimeRouting.test.js`, `.github/workflows/ai-dispatcher-v3-ci.yml`, and `docs/CAD_API_REFERENCE.md`.

**Corrective behavior:** Authenticated callers of `POST /api/dispatch/notify-emergency` now receive HTTP **410 Gone**, `triggered: false` and code `LEGACY_EMERGENCY_INGRESS_DISABLED`; the handler no longer reads caller-supplied unit/channel as emergency authority, loads the manager or starts any emergency state. The previously exposed compatibility `aiService.handleEmergencySignal` forwarding shortcut was removed. Legitimate `signalingService.onEmergencyStart`/`onEmergencyEnd` still reach the V3 runtime; normal PTT, admin stop/takeover, center isolation and physical emergency state were not changed.

**Nine new synthetic regression assertions** cover seven HTTP payload variations (same-unit, foreign-unit, foreign-center, unknown channel, self-asserted hardware origin, inactive and missing fields), repeated notifications across stop/restart and unavailable runtimes, and legitimate emergency callback delivery solely to the matching dispatch center. Existing live-runtime emergency regression coverage remains.

### Actual GitHub CI result

[Run **42918286141**](https://github.com/Jreeder-stack/reeder-radio-backend/actions/runs/42918286141), `b1cab9645bc43d4464a2d3f0297560367b7c9717`, Node v20.20.2 / GitHub-hosted Linux, November 10, 2026.

| Job / tested surface | Verified result |
| --- | --- |
| V3 scoped job `130186281011` | **SUCCESS**: 683/683 V3 across 62 files, 72/72 synthetic acceptance, 90/90 PTT tests across 5 files (was 81; nine new), 8/8 manager, 26/26 audit assertions, runtime boundary syntax and obsolete-engine checks |
| G-01 full repository job `130186281468` | **FAILURE overall**: all **955/955 root tests across 90 files pass**; Node server syntax passes; web client `npm ci`/`npm run build` passes; desktop gateway `npm test` passes **10/10**; two pre-existing iOS project checks still FAIL |
| iOS source inventory | **FAIL**: four undeclared Swift files and an outdated `project.pbxproj`, identical known historical baseline failure |
| iOS SwiftPM lock inventory | **FAIL**: missing `Package.resolved`, identical known historical baseline failure |

Exact commands remain in the one-time G-01 workflow and preceding report. The new test cases ran in both the full root suite and the existing focused PTT group. GitHub-reported artifacts: V3 `13809469179` SHA-256 `9870fc622bfcf52b0cc8e98ef045bdc58ae5edb6e9c05de6e45e6368e2ab92f9`; root `13809424286` SHA-256 `445599bd632f1da0669fa7a8080bb01270e820d29dbb11e5e26ca6555bbef687`. Artifact digests are reported by GitHub, **not independently rehashed**. Do not report the overall workflow green or silently disregard iOS.

**Remaining:** The safety blocker from the legacy HTTP emergency route is now **coded and synthetic-tested**, not live-deployed or field-verified. G-01 stays unchecked because the complete job is red, iOS applicability has not been approved as a scope exclusion, and newer-main/alternate environment integration remains unresolved. G-02–G-04 remain unchecked. PR #163 stays draft/open/unmerged/unmergeable. No provider, schema, transport, codec or firmware change; no merge, rebase, deployment, restart, real provider call, production CAD write or live radio test. The latest **CI-tested executable commit is `b1cab9645bc43d4464a2d3f0297560367b7c9717`**; any subsequent documentation-only commit does not imply a new executable test run.

## Final G-01 backend release qualification: resolved after main integration

**Current disposition (November 10, 2026, November 11 UTC): G-01 [x] QUALIFIED for the backend-only AI Dispatcher V3 pull-request candidate.** This section supersedes the historical red/incomplete results above; it does **not** certify live audio, iOS, production, or G-02 through G-04.

- **Merge reconciliation:** V3 branch commit `144e52e1ed4feeaf47ae215875621db069f9d719` has parents `0e4983fcc3a083334886c24a508fdcfc47d6cacf` (V3 documentation HEAD) and `f0d432a5beddc9770d99b297fed131b4bdf08ce5` (then-current `main`). All 57 main-only changed files were preserved by their original Git blob identities; the sole overlapping file, `src/services/signalingService.js`, combined main's native page receipt/replay handlers with the existing V3 PTT credential provenance and per-unit callback custody. GitHub confirmed PR #163 was mergeable after this reconciliation, without merging the PR.
- **CI qualification:** [GitHub run 42929542454](https://github.com/Jreeder-stack/reeder-radio-backend/actions/runs/42929542454) on `a644afb0791527d8e0a99dd6b186afea3f588079`: V3 job `130224505533` **SUCCESS** and G-01 repository job `130224504894` **SUCCESS**. Node 20.20.2 Linux runner. All **963/963 repository tests across 91 files**, **683/683 V3**, **72/72 synthetic acceptance**, **90/90 PTT**, **8/8 manager**, **26/26 audit**, web build, desktop **10/10**, backend syntax and removed-engine checks passed. The latest V3 runtime executable remains `b1cab9645bc43d4464a2d3f0297560367b7c9717`; reconciliation changes introduced no new dispatcher engine or model/provider behavior.
- **Native build applicability:** The G-01 job compared this candidate's complete `ios-native/` and `android-native/` trees to current `origin/main` and **passed source equivalence**. These are unchanged native clients, so their platform-specific builds/inventory failures are not silently represented as passing G-01 backend checks. `ios-pbxproj-check.yml` still checks iOS on `main` pushes and on pull requests that modify `ios-native/`. The pre-existing missing Swift group declarations and `Package.resolved` remain unresolved on `main`. No Xcode build or actual iPhone qualification was performed; those are separate release obligations for iOS.
- **Android check:** [T320 build run 42929698942](https://github.com/Jreeder-stack/reeder-radio-backend/actions/runs/42929698942) passed using the GitHub Ubuntu runner's installed SDK after removing the obsolete `setup-android@v3` invocation that attempted to install an unavailable SDK `tools` package. Earlier Android phone/bridge CI [42928858516](https://github.com/Jreeder-stack/reeder-radio-backend/actions/runs/42928858516) passed on identical native source. The dedicated native PR workflows are scoped to actual native-source changes; `main` push coverage remains. No mobile app source was changed.
- **Exact G-01 commands:** `npm ci`; `npm test -- --reporter=default --reporter=json --outputFile=reports/g01-full-repository-tests.json`; `node --check src/server.js`; `node --check server.js`; `npm ci --prefix client`; `npm run build --prefix client`; `npm test --prefix desktop-app`; and `git diff --quiet origin/main HEAD -- ios-native/ android-native/` after fetching `origin/main`. The V3 job additionally runs all boundary syntax/removed-engine checks, five PTT test files, manager integration, `npm run test:v3`, and `node scripts/dispatcher-v3-acceptance.mjs --synthetic` as recorded in the workflow above.
- **Boundaries:** G-02 [ ], G-03 [ ], G-04 [ ]. No live/paid provider, external Command Link test environment, five-real-unit audio and latency/cost evaluation, pilot, deployed revision, original field-symptom verification, or production rollback acceptance was performed. Do not conflate GitHub code-review/mergeability with authorization for production release. No PR merge, rebase, service restart, deployment, or production data modification occurred.
