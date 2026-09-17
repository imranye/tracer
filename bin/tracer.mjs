#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const config = join(homedir(), ".config", "tracer", "config.json");
const readConfig = () => existsSync(config) ? JSON.parse(readFileSync(config, "utf8")) : {};
const usage = () => console.log("tracer login <url> <token>\ntracer pull <environment-id>\ntracer run <environment-id> -- <command> [args...]");
const [command, ...args] = process.argv.slice(2); const cfg = readConfig();
if (command === "login") { if (!args[0] || !args[1]) usage(); else { mkdirSync(join(homedir(), ".config", "tracer"), { recursive: true, mode: 0o700 }); writeFileSync(config, JSON.stringify({ url: args[0].replace(/\/$/, ""), token: args[1] }, null, 2), { mode: 0o600 }); console.log("Tracer device configured."); } }
else if (command === "pull") { const r = await fetch(`${cfg.url}/api/environments/${args[0]}/values`, { headers: { authorization: `Bearer ${cfg.token}` } }); if (!r.ok) throw new Error(`Tracer request failed: ${r.status}`); const { values } = await r.json(); for (const [k,v] of Object.entries(values)) console.log(`${k}=${JSON.stringify(v)}`); }
else if (command === "run") { const split=args.indexOf("--"); if(split<1||split===args.length-1) usage(); else { const envId=args[0]; const r=await fetch(`${cfg.url}/api/environments/${envId}/values`,{headers:{authorization:`Bearer ${cfg.token}`}});if(!r.ok)throw new Error(`Tracer request failed: ${r.status}`);const {values}=await r.json();execFileSync(args[split+1],args.slice(split+2),{stdio:"inherit",env:{...process.env,...values}}); } }
else usage();
