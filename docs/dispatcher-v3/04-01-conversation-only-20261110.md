# AI Dispatcher V3 04-01: First-class conversation-only radio response

**Plan:** AI-DISP-V3-001. **Original item:** 04-01. **Date:** November 10, 2026.
**Repository:** `Jreeder-stack/reeder-radio-backend`; **branch:** `test/dispatcher-v3-01-01-baseline-20261028`; **PR:** [#163](https://github.com/Jreeder-stack/reeder-radio-backend/pull/163), draft/open/unmerged/unmergeable.

## Root cause and blast radius

Semantic interpretation already classified some addressed transmissions as `conversation_only` with `action: NO_ACTION`, but `composeV3Response` unconditionally returned `null` for `NO_ACTION`. The V3 outbound scheduler was never given a reply, so questions and acknowledgments without CAD work were silently discarded. Passive observations, quoted historical/negated commands and unaddressed unit-to-unit chatter also appropriately used non-mutating decisions and had to remain safe. The cause was the missing response contract, not the STT provider, PTT transport, CAD endpoint, firmware, or V1/V2 fallback.

## Implemented

- Added `src/dispatcher-v3/conversationReplies.js` with a strictly finite set of semantic conversational response types: `presence`, `acknowledgement`, `identity`, `channel`, `capabilities`, `request_details`, and `standby`. The model chooses meaning, not a list of input phrases.
- `normalizeV3SemanticPlan` accepts `conversationAct` **only** with `NO_ACTION` and `conversation_only`, without action inputs. It rejects unsupported act values, controls, observations or CAD actions that claim a conversation reply. Model-supplied arbitrary reply text, unit identities, authorization, CAD success and emergency controls are not used for spoken output. A legacy `NO_ACTION` without explicit conversation intent remains silent; an explicit conversation-only reply without an act defaults safely to acknowledgement.
- `composeV3Response` uses the new composer only for a verified V3 plan of that kind, with the recipient derived from the authenticated turn and channel metadata supplied by the runtime, never the model. Output is concise and bounded. Questions requiring CAD status or call facts continue through the already verified read tools.
- `liveRuntime.js` routes the composed sentence through the existing `_queueReply` outbound lane, floor controller and the same unit-owned turn/task lifecycle and diagnostics. It does not call `executor.execute`, create new CAD mutation privileges, revive emergency states, or open an undelivered clarification answer window.
- Updated the existing Azure JSON semantic planner instructions to select a conversational act for addressed requests requiring no CAD action, distinguish passive observations and legitimate CAD read questions, and avoid fabricated outcomes. Kept the existing speech/model provider, deterministic safe fast path, CAD authority, channel and center isolation, turn freshness and hardware emergency rules.

## Scoped evidence

**Starting documentation HEAD:** `f02290ed0ce1116268a1b0adc8d48d95f3f1529a`.
**Previously validated executable:** `5d2ef11155501f87fac7f245ac57b2880b4ba802`.
**Implementation and scoped validated executable:** `adb8c44102d5431c06401053ada554518abd0add`.

[GitHub Actions run 42837273748](https://github.com/Jreeder-stack/reeder-radio-backend/actions/runs/42837273748), job `129902724586`, Node 20: **12/12 new 04-01**, **635/635 total V3**, 55 test files, **26/26** original audit, **81/81** PTT, **8/8** manager integration; all workflow steps green including syntax and legacy-engine absence.

The new tests traverse credential-backed PTT intake, authenticated unit and center identity, the real V3 planner normalization, conversation state, response composition, floor-controlled synthetic audio output and cleanup with mocked model/STT/TTS and CAD HTTP. They verify presence checks, acknowledgments, standby, unfamiliar phrasing mapped by a mocked semantic output, runtime-grounded channel/identity, capabilities, passive observation silence, legacy NO_ACTION compatibility, true unaddressed unit traffic ignored at the gate, different units and centers, normal radio check/status regression, model act spoofing rejected and response bounds. No paid calls, live CAD or production data.

**Artifact:** GitHub-reported `13773508271`, `dispatcher-v3-evidence-42837273748-1`, SHA-256 `65e2f5c018c14b93665a07c2bc02fb1e789fd226459df58292411939d7cccf5f`; not independently downloaded/rehashed.

## Limits and next

The model's response-act selection was synthetically supplied. This validates safe plan/response/radio wiring, **not** general-model success with unseen audio, real radio audibility, latency, realistic human conversation, or model-generated grounded factual prose. Parent 04-02 remains responsible for richer, concise, grounded reply generation, 04-03 for clarification, 04-04 for actionable errors, 04-05 for takeover discipline, 04-06 for held-out evaluation and 04-07–04-08 for integration/runbook. Full repo/mobile, newer-main compatibility, external Command Link integration, live providers, supervised pilot, deployment and G-01 through G-04 remain unverified. No V1/V2/V4, provider migration, schema, codec, transport or firmware changes occurred.

**Coding:** 04-01 complete. **Scoped synthetic validation:** complete. **Release/field acceptance:** not established. Parent 01 8/8, Parent 02 8/8, Parent 03 8/8, Parent 04 **1/8**, total **25/32**. **Next exact original item: 04-02.**
