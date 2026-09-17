#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

const config = join(homedir(), ".config", "tracer", "config.json");
const readConfig = () => existsSync(config) ? JSON.parse(readFileSync(config, "utf8")) : {};
const save = cfg => { mkdirSync(join(homedir(), ".config", "tracer"), { recursive: true, mode: 0o700 }); writeFileSync(config, JSON.stringify(cfg, null, 2), { mode: 0o600 }); };
const usage = () => console.log("tracer login <url> [token]\ntracer import [file] [environment-id]\ntracer pull <environment-id>\ntracer run <environment-id> -- <command> [args...]");
const open = url => { const cmd = platform() === "darwin" ? "open" : platform() === "win32" ? "cmd" : "xdg-open"; const args = platform() === "win32" ? ["/c", "start", "", url] : [url]; spawn(cmd, args, { detached: true, stdio: "ignore" }).unref(); };
const request = async (url, options = {}) => { const r = await fetch(url, options); if (!r.ok) throw new Error(`Tracer request failed: ${r.status}`); return r.json(); };
const parseEnv = text => text.split(/\r?\n/).flatMap(line => { const clean = line.trim(); if (!clean || clean.startsWith("#")) return []; const match = clean.replace(/^export\s+/, "").match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (!match) return []; let value = match[2].trim(); if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1); return [{ name: match[1], value }]; });
const importFile = async (cfg, file, environmentId) => { if (!existsSync(file)) throw new Error(`File not found: ${file}`); const variables = parseEnv(readFileSync(file, "utf8")); if (!variables.length) throw new Error("No variables found in the file."); const result = await request(`${cfg.url}/api/variables/bulk`, { method: "POST", headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" }, body: JSON.stringify({ environment_id: environmentId, variables }) }); console.log(`Imported ${result.imported} variables from ${file}.`); };
const syncEnvironment = async (cfg, url, token) => { const state = await request(`${url}/api/state`, { headers: { authorization: `Bearer ${token}` } }); const environmentId = state.environments?.[0]?.id; if (!environmentId) throw new Error("No Tracer environment found."); const next = { url, token, environment_id: environmentId }; save(next); return next; };
const [command, ...args] = process.argv.slice(2); let cfg = readConfig();

if (command === "login") {
  if (!args[0]) usage();
  else if (args[1]) { cfg = await syncEnvironment(cfg, args[0].replace(/\/$/, ""), args[1]); console.log("Tracer device configured."); }
  else { const base = args[0].replace(/\/$/, ""); const started = await request(`${base}/api/device/start`, { method: "POST" }); console.log("Opening Tracer in your browser. Approve this device to finish login..."); open(started.authorize_url); for (let i = 0; i < 60; i++) { await new Promise(resolve => setTimeout(resolve, 2000)); try { const result = await request(`${base}/api/device/poll?request_token=${encodeURIComponent(started.request_token)}`); if (result.status === "approved") { cfg = await syncEnvironment(cfg, base, result.token); console.log("Logged in to Tracer."); break; } } catch {} if (i === 59) throw new Error("Login timed out. Run tracer login again."); } }
  const file = args[2] || ".env"; if (existsSync(file) && process.stdin.isTTY) { const rl = createInterface({ input: process.stdin, output: process.stdout }); const answer = await rl.question(`Found ${file}. Import it into Tracer development? [Y/n] `); rl.close(); if (!answer.trim() || /^y(es)?$/i.test(answer.trim())) await importFile(cfg, file, cfg.environment_id); }
} else if (command === "import") {
  const file = args[0] || ".env"; const environmentId = args[1] || cfg.environment_id; if (!cfg.url || !cfg.token || !environmentId) throw new Error("Run tracer login first."); await importFile(cfg, file, environmentId);
} else if (command === "pull") {
  const { values } = await request(`${cfg.url}/api/environments/${args[0]}/values`, { headers: { authorization: `Bearer ${cfg.token}` } }); for (const [k, v] of Object.entries(values)) console.log(`${k}=${JSON.stringify(v)}`);
} else if (command === "run") {
  const split = args.indexOf("--"); if (split < 1 || split === args.length - 1) usage(); else { const { values } = await request(`${cfg.url}/api/environments/${args[0]}/values`, { headers: { authorization: `Bearer ${cfg.token}` } }); execFileSync(args[split + 1], args.slice(split + 2), { stdio: "inherit", env: { ...process.env, ...values } }); }
} else usage();
