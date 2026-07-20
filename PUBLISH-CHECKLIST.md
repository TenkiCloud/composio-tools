# Publish checklist — @tenkicloud/composio-tools

Status: code complete and live-validated (unit tests 24/24, `pnpm smoke` 11/11 steps, `pnpm agent` 5/5 checks on 2026-07-14). Everything below is what stands between this folder and `npm install @tenkicloud/composio-tools`.

## 1. Decisions (need sign-off from the Tenki team)

- [ ] **Package name.** `@tenkicloud/composio-tools` (matches the `@tenkicloud/sandbox` scope; recommended). Alternatives considered: `@tenkicloud/composio` (too broad), `composio-tenki` (unscoped, follows `langchain-tenki` precedent but loses the org scope).
- [x] **GitHub org.** Decided: `TenkiCloud` (github.com/TenkiCloud — Tenki's official org). Repo transfers from `AlexanderArmua/composio-tools`.
- [ ] **License holder line.** `LICENSE` currently says "Luxor Technology Corporation (Tenki Cloud)" — confirm or correct the legal entity.

## 2. Repo setup

- [ ] `git init` + initial commit (proposed messages below), push to the chosen org.
- [ ] Fill `repository`, `homepage`, and `bugs` fields in `package.json` once the repo URL exists.
- [ ] Enable branch protection on `main` (require CI green + 1 review).
- [ ] CI is already included at `.github/workflows/ci.yml` (format check, typecheck, unit tests, build on Node 18/20/22). It needs no secrets — unit tests are fully mocked.

## 3. npm

- [ ] Confirm access to the `@tenkicloud` npm org (same owners as `@tenkicloud/sandbox`); enable 2FA / granular automation token.
- [ ] First publish (manual is fine for 0.1.0):
  ```bash
  pnpm install && pnpm test && pnpm build
  npm publish --access public
  ```
- [ ] Verify from a clean directory: `npm install @tenkicloud/composio-tools @composio/core` + run the README quickstart.
- [ ] Optional hardening for later releases: publish from CI with `--provenance` (OIDC), add changesets for versioning/changelog.

## 4. Pre-publish hygiene

- [ ] Delete the local `.env` and **revoke both test API keys** (Tenki `tk_…` and Composio `ak_…`) — they were used throughout Phase B testing.
- [ ] Confirm `.env` is not tracked (`git status` before first commit; `.gitignore` covers it).
- [ ] `npm pack --dry-run` — confirm only `dist/`, `README.md`, `LICENSE` ship.

## 5. Post-publish (feeds Phase B close-out and Phase C)

- [ ] Add a "Use Tenki from Composio" recipe to tenki.cloud docs (master plan, Phase B item 5).
- [ ] Update Notion Integration Platform → Composio row with the npm link.
- [ ] Decide on the optional second example PR to ComposioHQ/composio showing the package (master plan, Phase B item 4 — deferred until Phase A PR gets maintainer feedback).
- [ ] Include the package link in the Phase C outreach bundle to Composio.

## Proposed commit messages (you commit — conventional commits)

Single-commit option (fresh repo):

```
feat: initial release of @tenkicloud/composio-tools v0.1.0

Tenki custom toolkit for Composio: six sandbox tools (create, exec,
list, get, snapshot, terminate) built on experimental_createToolkit,
with mocked unit tests, live smoke test, and agentic E2E test.
```

Split option:

```
feat: scaffold @tenkicloud/composio-tools package
feat: implement TENKI custom toolkit with six sandbox tools
test: add unit tests with mocked Tenki SDK
test: add live smoke and Claude agent E2E scripts
docs: add README, publish checklist, and CI workflow
```
