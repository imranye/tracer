#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

const config = join(homedir(), ".config", "tracer", "config.json");
const readConfig = () => existsSync(config) ? JSON.parse(readFileSync(config, "utf8")) : {};
const usage = () => console.log("tracer login <url> [token]\ntracer pull <environment-id>\ntracer run <environment-id> -- <command> [args...]");
const open = (url) => { const cmd = platform() === "darwin" ? "open" : platform() === "win32" ? "cmd" : "xdg-open"; const args = platform() === "win32" ? ["/c", "start", "", url] : [url]; spawn(cmd, args, { detached: true, stdio: "ignore" }).unref(); };
const save = (cfg) => { mkdirSync(join(homedir(), ".config", "tracer"), { recursive: true, mode: 0o700 }); writeFileSync(config, JSON.stringify(cfg, null, 2), { mode: 0o600 }); };
const request = async (url, options = {}) => { const r = await fetch(url, options); if (!r.ok) throw new Error(`Tracer request failed: ${r.status}`); return r.json(); };
const [command, ...args] = process.argv.slice(2); const cfg = readConfig();

if (command === "login") {
  if (!args[0]) usage();
  else if (args[1]) { save({ url: args[0].replace(/\/$/, ""), token: args[1] }); console.log("Tracer device configured."); }
  else {
    const base = args[0].replace(/\/$/, ""); const started = await request(`${base}/api/device/start`, { method: "POST" });
    console.log("Opening Tracer in your browser. Approve this device to finish login..."); open(started.authorize_url);
    for (let i = 0; i < 60; i++) { await new Promise(resolve => setTimeout(resolve, 2000)); try { const result = await request(`${base}/api/device/poll?request_token=${encodeURIComponent(started.request_token)}`); if (result.status === "approved") { save({ url: base, token: result.token }); console.log("Logged in to Tracer."); process.exit(0); } } catch { /* keep polling until timeout */ } }
    throw new Error("Login timed out. Run tracer login again.");
  }
} else if (command === "pull") {
  const { values } = await request(`${cfg.url}/api/environments/${args[0]}/values`, { headers: { authorization: `Bearer ${cfg.token}` } }); for (const [k, v] of Object.entries(values)) console.log(`${k}=${JSON.stringify(v)}`);
} else if (command === "run") {
  const split = args.indexOf("--"); if (split < 1 || split === args.length - 1) usage(); else { const { values } = await request(`${cfg.url}/api/environments/${args[0]}/values`, { headers: { authorization: `Bearer ${cfg.token}` } }); execFileSync(args[split + 1], args.slice(split + 2), { stdio: "inherit", env: { ...process.env, ...values } }); }
} else usage();
