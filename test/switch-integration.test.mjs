// End-to-end switch logic on FAKE data: a fake transcript + a fake vault.
// Proves: a real flagged limit event triggers a swap of the active login, while
// look-alike events (unflagged "limit" text, or a different API error) do NOT.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isLimitEvent, pickNextAccount } from "../lib/core.mjs";
import { capture, activate, whichActive, activePath, newestTranscript, isCaptured } from "../lib/vault.mjs";

let root, cfg;
const creds = (org) => JSON.stringify({ claudeAiOauth: { accessToken: "t-" + org }, organizationUuid: org });
const line = (o) => JSON.stringify(o) + "\n";
const orgOfActive = () => JSON.parse(readFileSync(activePath(cfg, "claude"), "utf8")).organizationUuid;

before(() => {
  root = mkdtempSync(join(tmpdir(), "agecs-int-"));
  mkdirSync(join(root, "active"), { recursive: true });
  mkdirSync(join(root, "projects", "proj"), { recursive: true });
  cfg = {
    activeDirs: { claude: join(root, "active") },
    vaultDir: join(root, "vault"),
    transcriptsDir: join(root, "projects"),
    defaultCooldownHours: 5,
    providers: { claude: { credFile: ".credentials.json", identityField: "organizationUuid", continueArgs: ["--continue"], accounts: ["claude-1", "claude-2"] } },
    limitPatterns: ["5-hour limit", "weekly limit", "usage limit", "limit reached", "rate limit"],
  };
  writeFileSync(activePath(cfg, "claude"), creds("org-A")); capture(cfg, "claude", "claude-1");
  writeFileSync(activePath(cfg, "claude"), creds("org-B")); capture(cfg, "claude", "claude-2");
  activate(cfg, "claude", "claude-1");
});
after(() => rmSync(root, { recursive: true, force: true }));

function scanForLimit() {
  const f = newestTranscript(cfg);
  const lines = readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean);
  return lines.map((l) => JSON.parse(l)).some((o) => isLimitEvent(o, cfg.limitPatterns));
}

test("baseline: claude-1 active, both accounts saved", () => {
  assert.equal(whichActive(cfg, "claude"), "claude-1");
  assert.ok(isCaptured(cfg, "claude", "claude-2"));
});

test("fake transcript WITHOUT a real limit does not switch", () => {
  writeFileSync(join(root, "projects", "proj", "s.jsonl"),
    line({ type: "user", timestamp: new Date().toISOString(), message: { content: "fix the rate limit bug please" } }) +
    line({ type: "assistant", uuid: "x1", timestamp: new Date().toISOString(), message: { content: "working on it, limit reached -> batched" } }) +
    line({ type: "assistant", uuid: "x2", isApiErrorMessage: true, timestamp: new Date().toISOString(), message: { content: "API Error: overloaded_error" } }));
  assert.equal(scanForLimit(), false);
  assert.equal(whichActive(cfg, "claude"), "claude-1");
});

test("fake transcript WITH a real usage-limit event triggers the swap", () => {
  writeFileSync(join(root, "projects", "proj", "s.jsonl"),
    line({ type: "user", timestamp: new Date().toISOString(), message: { content: "keep going" } }) +
    line({ type: "assistant", uuid: "lim", isApiErrorMessage: true, timestamp: new Date().toISOString(),
           message: { model: "<synthetic>", content: "Claude usage limit reached. Your limit will reset at 1900000000." } }));
  assert.equal(scanForLimit(), true);

  const next = pickNextAccount({ accounts: cfg.providers.claude.accounts, activeName: "claude-1", cooldownUntil: { "claude-1": Date.now() + 3600e3 }, now: Date.now() });
  assert.equal(next, "claude-2");
  activate(cfg, "claude", next);
  assert.equal(whichActive(cfg, "claude"), "claude-2");
  assert.equal(orgOfActive(), "org-B");
});

test("after swap, if claude-2 ALSO caps and no account is free, pickNext returns null", () => {
  const cd = { "claude-1": Date.now() + 3600e3, "claude-2": Date.now() + 3600e3 };
  assert.equal(pickNextAccount({ accounts: cfg.providers.claude.accounts, activeName: "claude-2", cooldownUntil: cd, now: Date.now() }), null);
});
