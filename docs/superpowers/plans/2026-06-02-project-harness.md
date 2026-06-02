# Project Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a project harness that protects local production while keeping normal development verification fast.

**Architecture:** The harness is documentation and thin shell wrappers only. `AGENTS.md` gives Codex project rules, `docs/architecture.md` maps boundaries, `docs/harness.md` defines verification, and scripts wrap existing npm commands without changing application behavior.

**Tech Stack:** React, Vite, TypeScript, Node ESM, Express, Node test runner, POSIX shell.

---

### Task 1: Project Instructions

**Files:**
- Create: `AGENTS.md`

- [ ] **Step 1: Create project Codex rules**

Add `AGENTS.md` with project-specific rules for reading docs, using Karpathy Guidelines, protecting production commands, and choosing targeted verification.

- [ ] **Step 2: Verify the file is readable**

Run: `sed -n '1,220p' AGENTS.md`
Expected: the file prints complete project rules.

### Task 2: Architecture and Harness Docs

**Files:**
- Create: `docs/architecture.md`
- Create: `docs/harness.md`

- [ ] **Step 1: Create architecture map**

Add `docs/architecture.md` with concise descriptions of `src/`, `server/`, `ocr-service/`, `tests/`, runtime data, and project boundaries.

- [ ] **Step 2: Create verification matrix**

Add `docs/harness.md` with development defaults, production protection rules, and the targeted verification matrix.

- [ ] **Step 3: Verify docs are readable**

Run: `sed -n '1,220p' docs/architecture.md && sed -n '1,260p' docs/harness.md`
Expected: both documents print complete instructions.

### Task 3: Safe Shell Wrappers

**Files:**
- Create: `scripts/dev.sh`
- Create: `scripts/check.sh`
- Create: `scripts/test.sh`

- [ ] **Step 1: Create safe dev wrapper**

Add `scripts/dev.sh` as a POSIX shell script that supports `start`, `stop`, and `status`, and only calls development-safe npm scripts.

- [ ] **Step 2: Create full check wrapper**

Add `scripts/check.sh` as a POSIX shell script that runs `npm run check`, `npm run typecheck`, `npm test`, and `npm run build`.

- [ ] **Step 3: Create test wrapper**

Add `scripts/test.sh` as a POSIX shell script that runs `npm test` with no arguments or `node --test "$@"` with focused test file arguments.

- [ ] **Step 4: Make scripts executable**

Run: `chmod +x scripts/dev.sh scripts/check.sh scripts/test.sh`
Expected: executable bits are set.

### Task 4: Verification

**Files:**
- Inspect: `AGENTS.md`
- Inspect: `docs/architecture.md`
- Inspect: `docs/harness.md`
- Inspect: `scripts/dev.sh`
- Inspect: `scripts/check.sh`
- Inspect: `scripts/test.sh`

- [ ] **Step 1: Check shell syntax**

Run: `sh -n scripts/dev.sh && sh -n scripts/check.sh && sh -n scripts/test.sh`
Expected: no output and exit code 0.

- [ ] **Step 2: Run project static check**

Run: `npm run check`
Expected: command passes.

- [ ] **Step 3: Run targeted docs/harness review**

Run: `rg -n "TBD|TODO|FIXME|local:prod|\\.env\\.local|\\.runtime" AGENTS.md docs/architecture.md docs/harness.md scripts/dev.sh scripts/check.sh scripts/test.sh`
Expected: incomplete markers are absent; production and protected files only appear in protection rules.

- [ ] **Step 4: Review git diff**

Run: `git diff -- AGENTS.md docs/architecture.md docs/harness.md scripts/dev.sh scripts/check.sh scripts/test.sh docs/superpowers/plans/2026-06-02-project-harness.md`
Expected: diff only contains harness files.
