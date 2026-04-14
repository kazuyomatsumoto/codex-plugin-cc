import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");

function makeProjectDir() {
  const dir = makeTempDir();
  initGitRepo(dir);
  fs.mkdirSync(path.join(dir, ".claude", "plans"), { recursive: true });
  return dir;
}

function writePlan(dir, name, content = "# Plan\n\nStep 1: do the thing.") {
  const p = path.join(dir, ".claude", "plans", name);
  fs.writeFileSync(p, content, "utf8");
  return p;
}

function runPlanReview(cwd, env, ...extraArgs) {
  return run(
    "node",
    [SCRIPT, "plan-review", "--wait", "--scope", "working-tree", "--cwd", cwd, ...extraArgs],
    { cwd, env }
  );
}

function readFakeCodexState(binDir) {
  const statePath = path.join(binDir, "fake-codex-state.json");
  if (!fs.existsSync(statePath)) return null;
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

function getPlanDocumentSection(prompt) {
  const match = prompt.match(/<plan_document>\n([\s\S]*?)\n<\/plan_document>/);
  return match ? match[1] : null;
}

// --- Error path tests ---

test("plan-review fails when .claude/plans/ directory is absent", () => {
  const dir = makeTempDir();
  initGitRepo(dir);
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const result = runPlanReview(dir, buildEnv(binDir));

  assert.notEqual(result.status, 0);
  const out = result.stderr + result.stdout;
  assert.match(out, /No plan file found/i);
});

test("plan-review fails when .claude/plans/ is empty", () => {
  const dir = makeProjectDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const result = runPlanReview(dir, buildEnv(binDir));

  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /No plan file found/i);
});

test("plan-review fails when --plan names a nonexistent file", () => {
  const dir = makeProjectDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const result = runPlanReview(dir, buildEnv(binDir), "--plan", "nonexistent.md");

  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /No plan file found/i);
});

test("plan-review fails when plan file is empty", () => {
  const dir = makeProjectDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  writePlan(dir, "empty.md", "");

  const result = runPlanReview(dir, buildEnv(binDir));

  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /empty/i);
});

test("plan-review fails when plan file exceeds 200 KB", () => {
  const dir = makeProjectDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  writePlan(dir, "huge.md", "x".repeat(201 * 1024));

  const result = runPlanReview(dir, buildEnv(binDir));

  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /too large/i);
});

test("plan-review rejects traversal via --plan", () => {
  const dir = makeProjectDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  writePlan(dir, "ok.md");

  const result = runPlanReview(dir, buildEnv(binDir), "--plan", "../../etc/passwd");

  assert.notEqual(result.status, 0);
});

test("plan-review rejects absolute path outside plans directory", () => {
  const dir = makeProjectDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  writePlan(dir, "ok.md");
  // Write a file outside the plans dir
  const outsidePath = path.join(dir, "outside.md");
  fs.writeFileSync(outsidePath, "# Outside Plan", "utf8");

  const result = runPlanReview(dir, buildEnv(binDir), "--plan", outsidePath);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /outside allowed directories/i);
});

test("plan-review rejects non-.md file via --plan", () => {
  const dir = makeProjectDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  // Create a non-markdown file inside plans dir
  const plansDir = path.join(dir, ".claude", "plans");
  const txtPath = path.join(plansDir, "plan.txt");
  fs.writeFileSync(txtPath, "not markdown", "utf8");

  const result = runPlanReview(dir, buildEnv(binDir), "--plan", txtPath);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /must be a \.md file/i);
});

// --- Success path tests ---

test("plan-review picks the only plan file when --plan is omitted", () => {
  const dir = makeProjectDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  writePlan(dir, "the-plan.md", "# My Only Plan\n\nThis is the plan content.");

  const result = runPlanReview(dir, buildEnv(binDir));

  assert.equal(result.status, 0, result.stderr);
  const state = readFakeCodexState(binDir);
  const planDoc = getPlanDocumentSection(state.lastTurnStart.prompt);
  assert.ok(planDoc, "plan_document section should exist");
  assert.match(planDoc, /My Only Plan/);
  assert.match(planDoc, /the-plan\.md/);
});

test("plan-review picks newest plan when multiple exist", () => {
  const dir = makeProjectDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const older = writePlan(dir, "a-old.md", "# Old Plan");
  const newer = writePlan(dir, "b-new.md", "# New Plan");

  const now = Date.now();
  fs.utimesSync(older, new Date(now - 5000), new Date(now - 5000));
  fs.utimesSync(newer, new Date(now), new Date(now));

  const result = runPlanReview(dir, buildEnv(binDir));

  assert.equal(result.status, 0, result.stderr);
  const state = readFakeCodexState(binDir);
  const planDoc = getPlanDocumentSection(state.lastTurnStart.prompt);
  assert.match(planDoc, /New Plan/);
  assert.doesNotMatch(planDoc, /Old Plan/);
});

test("plan-review resolves --plan bare filename", () => {
  const dir = makeProjectDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  writePlan(dir, "specific.md", "# Specific Plan\n\nSelected by name.");

  const result = runPlanReview(dir, buildEnv(binDir), "--plan", "specific.md");

  assert.equal(result.status, 0, result.stderr);
  const state = readFakeCodexState(binDir);
  assert.match(getPlanDocumentSection(state.lastTurnStart.prompt), /Specific Plan/);
});

test("plan-review resolves --plan with explicit relative path", () => {
  const dir = makeProjectDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  writePlan(dir, "rel.md", "# Relative Path Plan");
  const relPath = path.join(".claude", "plans", "rel.md");

  const result = runPlanReview(dir, buildEnv(binDir), "--plan", relPath);

  assert.equal(result.status, 0, result.stderr);
  const state = readFakeCodexState(binDir);
  assert.match(getPlanDocumentSection(state.lastTurnStart.prompt), /Relative Path Plan/);
});

test("plan-review passes positional text as review focus (USER_FOCUS), not as plan path", () => {
  const dir = makeProjectDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  writePlan(dir, "my-plan.md", "# My Plan");

  // Pass natural-language focus text as positional args
  const result = runPlanReview(dir, buildEnv(binDir), "focus on rollback risks");

  assert.equal(result.status, 0, result.stderr);
  const state = readFakeCodexState(binDir);
  const prompt = state.lastTurnStart.prompt;
  // Plan document should contain the plan content
  assert.match(getPlanDocumentSection(prompt), /My Plan/);
  // Focus text should appear in the USER_FOCUS section
  assert.match(prompt, /User focus: focus on rollback risks/);
});

// --- Shadow / regression tests ---

test("plan-review in project mode ignores nested .claude/.claude/plans shadow", () => {
  const dir = makeProjectDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  writePlan(dir, "real.md", "# Real Plan");
  const shadow = path.join(dir, ".claude", ".claude", "plans");
  fs.mkdirSync(shadow, { recursive: true });
  fs.writeFileSync(path.join(shadow, "stale.md"), "# Stale Plan", "utf8");

  const result = runPlanReview(dir, buildEnv(binDir));

  assert.equal(result.status, 0, result.stderr);
  const planDoc = getPlanDocumentSection(readFakeCodexState(binDir).lastTurnStart.prompt);
  assert.match(planDoc, /Real Plan/);
  assert.doesNotMatch(planDoc, /Stale Plan/);
});

test("plan-review in conductor mode uses ~/.claude/plans, not {cwd}/.claude/.claude/plans", () => {
  // Mock HOME so os.homedir() returns a temp dir
  const fakeHome = makeTempDir();
  const conductorCwd = path.join(fakeHome, ".claude");
  const globalPlansDir = path.join(conductorCwd, "plans");
  const shadowDir = path.join(conductorCwd, ".claude", "plans");

  fs.mkdirSync(globalPlansDir, { recursive: true });
  fs.writeFileSync(path.join(globalPlansDir, "canonical.md"), "# Canonical Conductor Plan", "utf8");

  fs.mkdirSync(shadowDir, { recursive: true });
  fs.writeFileSync(path.join(shadowDir, "shadow.md"), "# Shadow Plan", "utf8");

  initGitRepo(conductorCwd);

  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const baseEnv = buildEnv(binDir);
  const env = { ...baseEnv, HOME: fakeHome };

  const result = run(
    "node",
    [SCRIPT, "plan-review", "--wait", "--scope", "working-tree", "--cwd", conductorCwd],
    { cwd: conductorCwd, env }
  );

  assert.equal(result.status, 0, result.stderr);
  const planDoc = getPlanDocumentSection(readFakeCodexState(binDir).lastTurnStart.prompt);
  assert.ok(planDoc, "plan_document section should exist");
  assert.match(planDoc, /Canonical Conductor Plan/);
  assert.doesNotMatch(planDoc, /Shadow Plan/);
});
