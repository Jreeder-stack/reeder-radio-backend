# Mandatory Development Workflow — Owner Requirements

These instructions are mandatory for all work in this repository, including work performed by ChatGPT, Codex, GitHub Copilot, other AI agents, contractors, and contributors. They are requirements, not suggestions.

## 1. Reported issues require a full root-cause workup

A reported symptom is the starting point of the investigation. Do not assume the visible symptom is the defect that should be patched.

Before proposing changes:

- Reproduce or precisely trace the reported workflow.
- Follow the complete data and control path through every relevant frontend, backend, database, API, WebSocket, integration, scheduler, mobile/desktop client, and related repository.
- Identify the first point where the system creates incorrect state or makes an incorrect decision.
- Determine the full blast radius, including other roles, agencies, tenants, dispatch centers, screens, applications, and background processes.
- Review existing architecture, conventions, tests, and prior related fixes before designing a solution.

Fix the root cause. Do not mask symptoms with response wording, retries, fallbacks, guards placed only at the final failure point, one-off handlers, prototype patches, preload wrappers, or other workaround-style changes when the underlying service or data model can be corrected directly.

## 2. Investigation is the default; implementation requires explicit approval

When the owner reports an issue or asks to "look into," "check," "review," "trace," or "figure out" something, the authorized scope is investigation only.

During investigation, do not:

- Edit or create repository files.
- Create or switch branches for implementation.
- Commit or push changes.
- Open, update, or merge a pull request containing implementation changes.
- Deploy or restart production services.
- Modify production data.

After investigation, present a game plan containing:

- Confirmed root cause and supporting evidence.
- Affected repositories, services, files, endpoints, tables, integrations, schedulers, and clients.
- Proposed architectural fix and why it addresses the root cause.
- Related defects or workflows affected by the same root cause.
- Risks, compatibility concerns, and possible regressions.
- Test plan, including negative, tenant-isolation, restart, and failure cases where applicable.
- Deployment, rollback, and live-verification plan.
- Items intentionally left unchanged.

Implementation may begin only after the owner clearly approves the plan or gives an unmistakable instruction such as "implement this plan," "go ahead and build it," or "make the full fix."

Do not infer approval from urgency, frustration, screenshots, logs, detailed discussion, or a request for thoughts and ideas.

## 3. Scope changes require renewed approval

Implementation must remain inside the approved plan.

If new investigation reveals a materially different root cause, a broader blast radius, a schema or architecture change, additional repositories, or meaningful new risk, stop implementation and present a revised game plan. Do not silently expand the work.

Small implementation details that do not change approved behavior or risk may be handled normally.

## 4. Merge and deployment authorization must be clear

Approval to implement does not automatically authorize merge or deployment unless the owner's instruction clearly includes completing the full build through production.

Report these states separately and accurately:

1. Investigation complete.
2. Plan approved.
3. Code implemented.
4. Tests passed.
5. Pull request ready.
6. Approved to merge.
7. Merged.
8. Deployed.
9. Original live scenario verified.

Never describe a change as fixed merely because code was written, a guard exists, a PR merged, or a build passed.

## 5. Completion standard

A fix is complete only when:

- The incorrect state or decision can no longer be created at its source.
- Related legitimate workflows continue to function.
- Relevant automated tests pass, including negative and isolation cases.
- The appropriate full build/test suites pass.
- Deployment is confirmed for every affected service.
- The original reported scenario is successfully verified after deployment.

If any part is unverified, state exactly what is complete and what remains unproven.

## 6. Cross-repository and multi-tenant requirements

Command Link and Command Comms are an integrated system. When a workflow crosses repositories, investigate and plan across both before changing either one.

For agency, tenant, CAD, and dispatch-center behavior, isolation must be enforced at the source of identity resolution and data ownership—not only filtered in the UI or rejected after incorrect state has already been created.

Tests must include same-tenant success and cross-tenant rejection, including duplicate names, duplicate callsigns, overlapping channel names, restarts, stale caches, and unavailable integrations where relevant.

## 7. No tool-driven architecture

Do not choose an inferior implementation because repository-editing, CI, connector, or deployment tooling is inconvenient.

Temporary workflows, patch scripts, monkey-patching, runtime wrapping, generated-file edits, and similar mechanisms must not become the production design unless they are independently justified as the correct architecture and approved in the game plan.

## 8. Owner control is mandatory

The owner controls scope, implementation, merge, and deployment. When uncertain whether an action is authorized, stop before making changes and present the findings and proposed next step.
