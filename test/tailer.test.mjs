// The transcript tailer used by `watch` (VS Code Claude Code panel) and `run`:
// it must fire once per NEW real limit, track the read offset so it doesn't
// re-fire, and ignore events from before it started. All on FAKE transcripts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeLimitTailer } from "../lib/vault.mjs";

const P = ["usage limit", "weekly limit", "5-hour limit", "limit reached"];
const line = (o) => JSON.stringify(o) + "\n";
const LIMIT = (uuid, content) => line({ uuid, isApiErrorMessage: true, message: { content } });

function setup() {
  const root = mkdtempSync(join(tmpdir(), "agecs-tail-"));
  mkdirSync(join(root, "p"), { recursive: true });
  return { root, cfg: { transcriptsDir: root, limitPatterns: P }, file: join(root, "p", "s.jsonl") };
}

test("tailer: null until a real limit, fires once, dedups, fires again on a fresh limit", () => {
  const { root, cfg, file } = setup();
  writeFileSync(file, line({ type: "user", message: { content: "hello" } }));
  const tail = makeLimitTailer(cfg, Date.now() - 1000);
  assert.equal(tail(), null, "no limit yet");

  writeFileSync(file, line({ type: "user", message: { content: "hello" } }) + LIMIT("l1", "usage limit reached"));
  assert.equal(tail().event.uuid, "l1", "fires on first limit");
  assert.equal(tail(), null, "same event not re-fired (offset + dedup)");

  writeFileSync(file,
    line({ type: "user", message: { content: "hello" } }) + LIMIT("l1", "usage limit reached") + LIMIT("l2", "weekly limit"));
  assert.equal(tail().event.uuid, "l2", "fires on the next, different limit");
  rmSync(root, { recursive: true, force: true });
});

test("tailer: ignores a limit event timestamped before launch", () => {
  const { root, cfg, file } = setup();
  const launch = Date.now();
  writeFileSync(file, line({ uuid: "old", isApiErrorMessage: true, timestamp: new Date(launch - 600000).toISOString(), message: { content: "usage limit reached" } }));
  assert.equal(makeLimitTailer(cfg, launch)(), null);
  rmSync(root, { recursive: true, force: true });
});

test("tailer: no transcripts dir -> null, no crash", () => {
  const cfg = { transcriptsDir: join(tmpdir(), "agecs-nope-" + Date.now()), limitPatterns: P };
  assert.equal(makeLimitTailer(cfg, Date.now())(), null);
});
