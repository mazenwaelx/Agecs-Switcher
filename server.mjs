#!/usr/bin/env node
// AGECS Switcher control panel — manage your saved logins and launch the
// auto-switcher. Localhost only, no dependencies. Exported as makeServer() so the
// test suite can drive it on an ephemeral port.

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { capture, activate, statusList } from "./lib/vault.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CFG = join(HERE, "accounts.json");
const isWin = process.platform === "win32";

const readCfg = () => JSON.parse(readFileSync(CFG, "utf8"));
const writeCfg = (c) => writeFileSync(CFG, JSON.stringify(c, null, 2) + "\n");
const providerOf = (cfg, name) => Object.entries(cfg.providers).find(([, p]) => p.accounts.includes(name))?.[0] || cfg.defaultProvider || "claude";

const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
const body = (req) => new Promise((r) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { try { r(JSON.parse(b || "{}")); } catch { r({}); } }); });

function state(cfg) {
  const accounts = [];
  for (const provider of Object.keys(cfg.providers)) accounts.push(...statusList(cfg, provider));
  return { accounts, providers: Object.keys(cfg.providers), defaultProvider: cfg.defaultProvider || "claude" };
}

// Open a real terminal window running an agecs command (login / run need a TTY).
function openTerminal(args, title) {
  const node = process.execPath, script = join(HERE, "agecs.mjs");
  if (isWin) spawn("cmd", ["/c", "start", title, "cmd", "/k", node, script, ...args], { cwd: HERE });
  else spawn(node, [script, ...args], { cwd: HERE, stdio: "inherit", detached: true });
}

export function makeServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const path = url.pathname;
    try {
      if (path === "/" || path === "/index.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(readFileSync(join(HERE, "ui.html"), "utf8"));
      }
      if (path === "/api/state") return json(res, 200, state(readCfg()));

      if (req.method === "POST") {
        const data = await body(req);
        const cfg = readCfg();
        if (path === "/api/login") { openTerminal(["login", data.name], "AGECS Login"); return json(res, 200, { ok: true }); }
        if (path === "/api/run") { openTerminal(["run", data.provider || "claude"], "AGECS Auto-Switch"); return json(res, 200, { ok: true }); }
        if (path === "/api/capture") { capture(cfg, providerOf(cfg, data.name), data.name); return json(res, 200, state(cfg)); }
        if (path === "/api/use") { activate(cfg, providerOf(cfg, data.name), data.name); return json(res, 200, state(cfg)); }
        if (path === "/api/account") {
          const prov = data.provider, p = cfg.providers[prov];
          if (!p || !data.name) return json(res, 400, { error: "bad name/provider" });
          if (data.action === "add" && !p.accounts.includes(data.name)) p.accounts.push(data.name);
          if (data.action === "remove") p.accounts = p.accounts.filter((n) => n !== data.name);
          writeCfg(cfg); return json(res, 200, state(cfg));
        }
      }
      res.writeHead(404); res.end("not found");
    } catch (e) { json(res, 500, { error: e.message }); }
  });
}

// Run directly: listen on 4319 and open the browser.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const PORT = 4319;
  makeServer().listen(PORT, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${PORT}`;
    console.log(`AGECS control panel -> ${url}  (vault: ${join(homedir(), ".agecs-switcher", "vault")})`);
    if (isWin) spawn("cmd", ["/c", "start", "", url]);
  });
}
