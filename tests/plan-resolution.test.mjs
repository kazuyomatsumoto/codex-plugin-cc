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
  return run("node", [SCRIPT, "plan-review", "--wait", "--scope", "working-tree", "--cwd", cwd, ...extraArgs], { cwd, env });
}

function readFakeCodexState(binDir) {
  const statePath = path.join(binDir, "fake-codex-state.json");
  if (!fs.existsSync(statePath)) return null;
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

// --- Error path tests (no Codex needed) ---

test("plan-review fails when .claude/plans/ directory is absent", () => {
  const dir = makeTempDir();
  initGitRepo(dir);
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const result = runPlanReview(dir, buildEnv(binDir));

  assert.notEqual(result.status, 0);
  const out = result.stderr + result.stdout;
  assert.match(out, /\.claude\/plans/);
});

test("plan-review fails when .claude/plans/ is empty", () => {
  const dir = makeProjectDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const result = runPlanReview(dir, buildEnv(binDir));

  assert.notEqual(result.status, 0);
  const out = result.stderr + result.stdout;
  assert.match(out, /No plan file found/i);
});

test("plan-review fails when named plan file does not exist", () => {
  const dir = makeProjectDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const result = runPlanReview(dir, buildEnv(binDir), "nonexistent.md");

  assert.notEqual(result.status, 0);
  const out = result.stderr + result.stdout;
  assert.match(out, /No plan file found/i);
});

test("plan-review fails when plan file is empty", () => {
  const dir = makeProjectDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  writePlan(dir, "empty.md", "");

  const result = runPlanReview(dir, buildEnv(binDir));

  assert.notEqual(result.status, 0);
  const out = result.stderr + result.stdout;
  assert.match(out, /empty/i);
});

test("plan-review fails when plan file exceeds 200 KB", () => {
  const dir = makeProjectDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  writePlan(dir, "huge.md", "x".repeat(201 * 1024));

  const result = runPlanReview(dir, buildEnv(binDir));

  assert.notEqual(result.status, 0);
  const out = result.stderr + result.stdout;
  assert.match(out, /too large/i);
});

test("plan-review rejects directory traversal in focusText", () => {
  const dir = makeProjectDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  writePlan(dir, "ok.md");

  const result = runPlanReview(dir, buildEnv(binDir), "../../etc/passwd");

  // Either fails to find the file or rejects as unsafe
  assert.notEqual(result.status, 0);
});

// --- Success path tests (requires fake Codex) ---

test("plan-review picks the only plan file when focusText is empty", () => {
  const dir = makeProjectDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const PLAN_CONTENT = "# My Only Plan\n\nThis is the plan content.";
  writePlan(dir, "the-plan.md", PLAN_CONTENT);

  const result = runPlanReview(dir, buildEnv(binDir));

  assert.equal(result.status, 0, result.stderr);
  const state = readFakeCodexState(binDir);
  assert.ok(state?.lastTurnStart?.prompt, "fake Codex should record lastTurnStart");
  assert.match(state.lastTurnStart.prompt, /My Only Plan/);
  assert.match(state.lastTurnStart.prompt, /the-plan\.md/);
  // Must NOT contain stale design.md or unrelated paths
  assert.doesNotMatch(state.lastTurnStart.prompt, /design\.md/);
});

test("plan-review picks newest plan when multiple exist", () => {
  const dir = makeProjectDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const older = writePlan(dir, "a-old.md", "# Old Plan");
  const newer = writePlan(dir, "b-new.md", "# New Plan");

  // Ensure newer has a later mtime
  const now = Date.now();
  fs.utimesSync(older, new Date(now - 5000), new Date(now - 5000));
  fs.utimesSync(newer, new Date(now), new Date(now));

  const result = runPlanReview(dir, buildEnv(binDir));

  assert.equal(result.status, 0, result.stderr);
  const state = readFakeCodexState(binDir);
  const prompt = state.lastTurnStart.prompt;
  // Extract plan_document section to verify only the newer plan is selected
  const planDocMatch = prompt.match(/<plan_document>\n([\s\S]*?)\n<\/plan_document>/);
  assert.ok(planDocMatch, "plan_document section should exist in prompt");
  assert.match(planDocMatch[1], /New Plan/);
  assert.doesNotMatch(planDocMatch[1], /Old Plan/);
});

test("plan-review resolves bare filename from focusText", () => {
  const dir = makeProjectDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  writePlan(dir, "specific.md", "# Specific Plan\n\nSelected by name.");

  const result = runPlanReview(dir, buildEnv(binDir), "specific.md");

  assert.equal(result.status, 0, result.stderr);
  const state = readFakeCodexState(binDir);
  assert.match(state.lastTurnStart.prompt, /Specific Plan/);
});

test("plan-review resolves explicit relative path from focusText", () => {
  const dir = makeProjectDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  writePlan(dir, "rel.md", "# Relative Path Plan");
  const relPath = path.join(".claude", "plans", "rel.md");

  const result = runPlanReview(dir, buildEnv(binDir), relPath);

  assert.equal(result.status, 0, result.stderr);
  const state = readFakeCodexState(binDir);
  assert.match(state.lastTurnStart.prompt, /Relative Path Plan/);
});
