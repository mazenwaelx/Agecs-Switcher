import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeServer } from "../server.mjs";

let server, base;
before(async () => {
  server = makeServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test("connection: /api/state responds with the account shape", async () => {
  const res = await fetch(base + "/api/state");
  assert.equal(res.status, 200);
  const s = await res.json();
  assert.ok(Array.isArray(s.accounts), "accounts is an array");
  assert.ok(s.providers.includes("claude"), "claude provider present");
  for (const a of s.accounts) {
    assert.equal(typeof a.name, "string");
    assert.equal(typeof a.captured, "boolean");
    assert.equal(typeof a.active, "boolean");
  }
});

test("connection: serves the control panel HTML", async () => {
  const res = await fetch(base + "/");
  assert.equal(res.status, 200);
  assert.match(await res.text(), /AGECS Switcher/);
});

test("connection: unknown path returns 404", async () => {
  const res = await fetch(base + "/nope");
  assert.equal(res.status, 404);
});

test("connection: bad account POST is handled, not crashed", async () => {
  const res = await fetch(base + "/api/account", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "add", name: "", provider: "nope" }) });
  assert.equal(res.status, 400);
});
