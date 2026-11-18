import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { capture, activate, isCaptured, whichActive, statusList, slotPath, activePath } from "../lib/vault.mjs";

let root, cfg;
const fakeCreds = (org) => JSON.stringify({ claudeAiOauth: { accessToken: "tok-" + org, refreshToken: "r-" + org }, organizationUuid: org });

before(() => {
  root = mkdtempSync(join(tmpdir(), "agecs-test-"));
  mkdirSync(join(root, "active-claude"), { recursive: true });
  cfg = {
    activeDirs: { claude: join(root, "active-claude") },
    vaultDir: join(root, "vault"),
    transcriptsDir: join(root, "nope"),
    providers: { claude: { credFile: ".credentials.json", identityField: "organizationUuid", accounts: ["claude-1", "claude-2"] } },
  };
});
after(() => rmSync(root, { recursive: true, force: true }));

test("capture fails when no one is logged in", () => {
  assert.throws(() => capture(cfg, "claude", "claude-1"), /no active login/);
});

test("capture then activate: round-trips the login file", () => {
  writeFileSync(activePath(cfg, "claude"), fakeCreds("org-A"));
  capture(cfg, "claude", "claude-1");
  assert.equal(isCaptured(cfg, "claude", "claude-1"), true);
  assert.equal(whichActive(cfg, "claude"), "claude-1");

  writeFileSync(activePath(cfg, "claude"), fakeCreds("org-B"));
  capture(cfg, "claude", "claude-2");
  assert.equal(whichActive(cfg, "claude"), "claude-2");

  activate(cfg, "claude", "claude-1");
  assert.equal(whichActive(cfg, "claude"), "claude-1");
  assert.equal(JSON.parse(readFileSync(activePath(cfg, "claude"), "utf8")).organizationUuid, "org-A");
});

test("activate an uncaptured account throws", () => {
  assert.throws(() => activate(cfg, "claude", "claude-404"), /not in the vault/);
});

test("whichActive returns null when the live login matches no snapshot", () => {
  writeFileSync(activePath(cfg, "claude"), fakeCreds("org-STRANGER"));
  assert.equal(whichActive(cfg, "claude"), null);
});

test("statusList reports captured/active/cooldown correctly", () => {
  writeFileSync(activePath(cfg, "claude"), fakeCreds("org-A"));
  const now = 1_000_000;
  const list = statusList(cfg, "claude", { "claude-2": now + 9999 }, now);
  const c1 = list.find((x) => x.name === "claude-1");
  const c2 = list.find((x) => x.name === "claude-2");
  assert.equal(c1.active, true);
  assert.equal(c1.captured, true);
  assert.equal(c1.coolingUntil, null);
  assert.equal(c2.active, false);
  assert.equal(c2.coolingUntil, now + 9999);
});

test("slotPath / activePath are under the configured dirs", () => {
  assert.ok(slotPath(cfg, "claude", "claude-1").startsWith(join(root, "vault")));
  assert.ok(activePath(cfg, "claude").startsWith(join(root, "active-claude")));
});
