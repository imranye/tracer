import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test, after } from "node:test";

const run = promisify(execFile);
const cli = join(process.cwd(), "bin/tracer.mjs");
let server;
let base;
let bulkBody;

server = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/api/state") return res.end(JSON.stringify({ environments: [{ id: "env-test" }] }));
  if (req.url === "/api/variables/bulk") { let body = ""; req.on("data", chunk => body += chunk); req.on("end", () => { bulkBody = JSON.parse(body); res.end(JSON.stringify({ imported: bulkBody.variables.length })); }); return; }
  if (req.url === "/api/environments/env-test/values") return res.end(JSON.stringify({ values: { TEST_SECRET: "runtime-only" } }));
  res.statusCode = 404; res.end(JSON.stringify({ error: "not found" }));
}).listen(0);
await new Promise(resolve => server.once("listening", resolve));
base = `http://127.0.0.1:${server.address().port}`;

after(() => server.close());

test("CLI login creates a private config and discovers the default environment", async () => {
  const home = await mkdtemp(join(tmpdir(), "tracer-home-"));
  await run(process.execPath, [cli, "login", base, "test-token"], { env: { ...process.env, HOME: home } });
  const saved = JSON.parse(await readFile(join(home, ".config/tracer/config.json"), "utf8"));
  assert.equal(saved.token, "test-token");
  assert.equal(saved.environment_id, "env-test");
});

test("CLI import parses dotenv syntax and uses the bulk API", async () => {
  const home = await mkdtemp(join(tmpdir(), "tracer-home-"));
  await run(process.execPath, [cli, "login", base, "test-token"], { env: { ...process.env, HOME: home } });
  const envFile = join(home, ".env");
  await writeFile(envFile, "# comment\nexport OPENAI_API_KEY=abc\nJEV=\"hello world\"\n");
  const result = await run(process.execPath, [cli, "import", envFile], { env: { ...process.env, HOME: home } });
  assert.match(result.stdout, /Imported 2 variables/);
  assert.deepEqual(bulkBody.variables, [{ name: "OPENAI_API_KEY", value: "abc" }, { name: "JEV", value: "hello world" }]);
});

test("CLI run injects values into the child process", async () => {
  const home = await mkdtemp(join(tmpdir(), "tracer-home-"));
  await run(process.execPath, [cli, "login", base, "test-token"], { env: { ...process.env, HOME: home } });
  const result = await run(process.execPath, [cli, "run", "env-test", "--", process.execPath, "-e", "process.stdout.write(process.env.TEST_SECRET ? 'injected' : 'missing')"], { env: { ...process.env, HOME: home } });
  assert.equal(result.stdout, "injected");
});

test("deployed Worker serves the landing page, skill, and auth boundary", async () => {
  const deployed = process.env.TRACER_URL || "https://tracer-env.imuthuvappa.workers.dev";
  assert.equal((await fetch(deployed)).status, 200);
  assert.equal((await fetch(`${deployed}/tracer-skill.md`)).status, 200);
  assert.equal((await fetch(`${deployed}/api/state`)).status, 401);
});

test("deployed Worker creates a pending device request", async () => {
  const deployed = process.env.TRACER_URL || "https://tracer-env.imuthuvappa.workers.dev";
  const response = await fetch(`${deployed}/api/device/start`, { method: "POST" });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.request_token);
  const pending = await fetch(`${deployed}/api/device/poll?request_token=${encodeURIComponent(body.request_token)}`);
  assert.equal(pending.status, 200);
  assert.deepEqual(await pending.json(), { status: "pending" });
});
