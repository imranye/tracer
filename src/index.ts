interface Env { DB: D1Database; TRACER_ADMIN_TOKEN: string; TRACER_ENCRYPTION_KEY: string }

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const id = () => crypto.randomUUID();

async function digest(value: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}
async function cryptKey(secret: string) {
  const raw = await digest(secret);
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function encrypt(value: string, secret: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await cryptKey(secret), new TextEncoder().encode(value)));
  const bytes = new Uint8Array(iv.length + encrypted.length); bytes.set(iv); bytes.set(encrypted, iv.length);
  return btoa(String.fromCharCode(...bytes));
}
async function decrypt(value: string, secret: string) {
  const bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0));
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, await cryptKey(secret), bytes.slice(12));
  return new TextDecoder().decode(plain);
}
async function authorized(request: Request, env: Env) {
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const [a, b] = await Promise.all([digest(supplied), digest(env.TRACER_ADMIN_TOKEN)]);
  if (a.length === b.length && a.every((byte, index) => byte === b[index])) return { admin: true };
  const token = await env.DB.prepare("SELECT account_id FROM access_tokens WHERE token_hash=?").bind(toHex(a)).first<{ account_id: string }>();
  return token ? { admin: false, accountId: token.account_id } : null;
}
const toHex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
type Auth = { admin: boolean; accountId?: string };
async function requireAuth(request: Request, env: Env) { const auth = await authorized(request, env); return auth ? { auth, error: null } : { auth: null, error: json({ error: "Unauthorized" }, 401) }; }

async function ensureDefaults(env: Env) {
  const existing = await env.DB.prepare("SELECT id FROM projects LIMIT 1").first();
  if (!existing) {
    const projectId = id(); const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO projects (id,name,slug,created_at) VALUES (?,?,?,?)").bind(projectId, "My projects", "default", now),
      env.DB.prepare("INSERT INTO environments (id,project_id,name) VALUES (?,?,?)").bind(id(), projectId, "development")
    ]);
  }
}

async function state(env: Env, auth: Auth) {
  await ensureDefaults(env);
  const filter = auth.admin ? "" : " WHERE account_id=?";
  const bind = auth.admin ? [] : [auth.accountId];
  const projects = await env.DB.prepare(`SELECT id,name,slug,created_at FROM projects${filter} ORDER BY created_at`).bind(...bind).all();
  const environments = auth.admin ? await env.DB.prepare("SELECT id,project_id,name FROM environments ORDER BY name").all() : await env.DB.prepare("SELECT e.id,e.project_id,e.name FROM environments e JOIN projects p ON p.id=e.project_id WHERE p.account_id=? ORDER BY e.name").bind(auth.accountId).all();
  const variables = auth.admin ? await env.DB.prepare("SELECT id,environment_id,name,updated_at FROM variables ORDER BY name").all() : await env.DB.prepare("SELECT v.id,v.environment_id,v.name,v.updated_at FROM variables v JOIN environments e ON e.id=v.environment_id JOIN projects p ON p.id=e.project_id WHERE p.account_id=? ORDER BY v.name").bind(auth.accountId).all();
  return json({ projects: projects.results, environments: environments.results, variables: variables.results });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/" && request.method === "GET") return new Response(APP, { headers: { "content-type": "text/html;charset=UTF-8" } });
    try {
      if (url.pathname === "/api/signup" && request.method === "POST") {
        const body = await request.json() as { email?: string; name?: string };
        if (!body.email?.includes("@") || !body.name?.trim()) return json({ error: "Name and email are required" }, 400);
        const accountId = id(); const token = `${id().replaceAll("-", "")}${id().replaceAll("-", "")}`; const now = new Date().toISOString(); const projectId = id(); const environmentId = id();
        await env.DB.batch([
          env.DB.prepare("INSERT INTO accounts (id,email,name,created_at) VALUES (?,?,?,?)").bind(accountId, body.email.trim().toLowerCase(), body.name.trim(), now),
          env.DB.prepare("INSERT INTO access_tokens (token_hash,account_id,created_at) VALUES (?,?,?)").bind(toHex(await digest(token)), accountId, now),
          env.DB.prepare("INSERT INTO projects (id,name,slug,created_at,account_id) VALUES (?,?,?,?,?)").bind(projectId, "My projects", "default-" + accountId.slice(0, 8), now, accountId),
          env.DB.prepare("INSERT INTO environments (id,project_id,name) VALUES (?,?,?)").bind(environmentId, projectId, "development")
        ]);
        return json({ token, environment_id: environmentId, skill_url: `${url.origin}/tracer-skill.md` }, 201);
      }
      if (url.pathname === "/tracer-skill.md" && request.method === "GET") return new Response(SKILL, { headers: { "content-type": "text/markdown; charset=UTF-8" } });
      const authResult = await requireAuth(request, env);
      if (authResult.error) return authResult.error;
      const auth = authResult.auth as Auth;
      if (url.pathname === "/api/state" && request.method === "GET") return state(env, auth);
      if (url.pathname === "/api/variables" && request.method === "POST") {
        const body = await request.json() as { environment_id?: string; name?: string; value?: string };
        if (!body.environment_id || !body.name || body.value === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(body.name)) return json({ error: "Invalid variable" }, 400);
        if (!auth.admin && !(await env.DB.prepare("SELECT e.id FROM environments e JOIN projects p ON p.id=e.project_id WHERE e.id=? AND p.account_id=?").bind(body.environment_id, auth.accountId).first())) return json({ error: "Not found" }, 404);
        const ciphertext = await encrypt(body.value, env.TRACER_ENCRYPTION_KEY);
        await env.DB.prepare("INSERT INTO variables (id,environment_id,name,ciphertext,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(environment_id,name) DO UPDATE SET ciphertext=excluded.ciphertext,updated_at=excluded.updated_at").bind(id(), body.environment_id, body.name, ciphertext, new Date().toISOString()).run();
        return json({ ok: true });
      }
      const match = url.pathname.match(/^\/api\/environments\/([^/]+)\/values$/);
      if (match && request.method === "GET") {
        if (!auth.admin && !(await env.DB.prepare("SELECT e.id FROM environments e JOIN projects p ON p.id=e.project_id WHERE e.id=? AND p.account_id=?").bind(match[1], auth.accountId).first())) return json({ error: "Not found" }, 404);
        const rows = await env.DB.prepare("SELECT name,ciphertext FROM variables WHERE environment_id=? ORDER BY name").bind(match[1]).all();
        const values: Record<string, string> = {};
        for (const row of rows.results as { name: string; ciphertext: string }[]) values[row.name] = await decrypt(row.ciphertext, env.TRACER_ENCRYPTION_KEY);
        return json({ values });
      }
      return json({ error: "Not found" }, 404);
    } catch (error) {
      console.error(JSON.stringify({ event: "request_error", message: error instanceof Error ? error.message : "unknown" }));
      return json({ error: "Request failed" }, 500);
    }
  }
};

const SKILL = `# Tracer secrets\n\nUse Tracer to run commands with the project environment without reading or printing secret values.\n\n## Setup\n\n    curl -fsSL TRACER_INSTALL_URL | sh\n    tracer login TRACER_URL TRACER_TOKEN\n\n## Run commands\n\n    tracer run ENVIRONMENT_ID -- codex\n    tracer run ENVIRONMENT_ID -- claude\n    tracer run ENVIRONMENT_ID -- npm test\n\nNever print environment variables, include their values in responses, or commit .env files. If a command needs a secret, run it through Tracer.\n`;

const APP = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tracer</title><style>
:root{font-family:ui-sans-serif,system-ui;background:#f6f7fb;color:#111827}body{max-width:980px;margin:0 auto;padding:42px 22px}h1{font-size:42px;letter-spacing:-.06em;margin:0}.sub{color:#667085;margin:6px 0 34px}.card{background:white;border:1px solid #e7e9ef;border-radius:16px;padding:22px;margin:16px 0;box-shadow:0 8px 24px #10182808}label{display:block;color:#667085;font-size:13px;font-weight:600;margin:14px 0 6px}input,select,button{font:inherit;padding:11px 12px;border:1px solid #d0d5dd;border-radius:9px}input,select{width:100%;box-sizing:border-box}button{background:#635bff;color:white;border:0;font-weight:650;cursor:pointer;margin-top:16px}.row{display:grid;grid-template-columns:1fr 1fr;gap:14px}.pill{display:inline-block;background:#eef2ff;color:#4338ca;padding:5px 9px;border-radius:999px;font-size:12px;margin:4px}.muted{color:#98a2b3;font-size:14px}.hidden{display:none}@media(max-width:640px){.row{grid-template-columns:1fr}}
</style></head><body><h1>tracer</h1><p class="sub">Your personal environment, wherever your agents run.</p><section class="card" id="signup"><h2>Start your vault</h2><p class="muted">Create a personal Tracer account in seconds. No credit card.</p><div class="row"><input id="signup-name" placeholder="Your name"><input id="signup-email" type="email" placeholder="you@example.com"></div><button onclick="signup()">Create my vault</button><p id="signup-status" class="muted"></p></section><section class="card"><h2>Already have Tracer?</h2><input id="token" type="password" placeholder="Paste your Tracer token"><button onclick="connect()">Connect this device</button></section><main id="app" class="hidden"><section class="card"><h2>Import your .env</h2><p class="muted">Values are encrypted on arrival and never displayed after import.</p><input id="envfile" type="file" accept=".env,text/plain"><button onclick="importEnv()">Import variables</button><p id="import-status" class="muted"></p></section><section class="card"><div class="row"><div><label>Environment</label><select id="environment"></select></div><div><label>Variable name</label><input id="name" placeholder="OPENAI_API_KEY"></div></div><label>Value</label><input id="value" type="password" placeholder="Secret value"><button onclick="save()">Save variable</button><p id="status" class="muted"></p></section><section class="card"><h2>Variables</h2><div id="vars"></div><p><a href="/tracer-skill.md">Download the agent skill</a></p></section></main><script>
let token=localStorage.tracer_token||'';let data;const headers=()=>({'authorization':'Bearer '+token,'content-type':'application/json'});async function signup(){let r=await fetch('/api/signup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:document.getElementById('signup-name').value,email:document.getElementById('signup-email').value})});let j=await r.json();if(!r.ok){document.getElementById('signup-status').textContent=j.error||'Could not sign up.';return}token=j.token;localStorage.tracer_token=token;document.getElementById('signup-status').textContent='Vault created. Your device is connected.';await load()}async function connect(){token=document.getElementById('token').value;localStorage.tracer_token=token;await load()}async function load(){let r=await fetch('/api/state',{headers:headers()});if(!r.ok){document.getElementById('app').classList.add('hidden');return}data=await r.json();document.getElementById('app').classList.remove('hidden');let s=document.getElementById('environment');s.innerHTML=data.environments.map(e=>'<option value="'+e.id+'">'+e.name+'</option>').join('');render()}function render(){let e=document.getElementById('environment').value;let vs=data.variables.filter(v=>v.environment_id===e);document.getElementById('vars').innerHTML=vs.length?vs.map(v=>'<span class="pill">'+v.name+'</span>').join(''):'<p class="muted">No variables yet.</p>'}document.getElementById('environment').onchange=render;async function save(){let r=await fetch('/api/variables',{method:'POST',headers:headers(),body:JSON.stringify({environment_id:document.getElementById('environment').value,name:document.getElementById('name').value,value:document.getElementById('value').value})});document.getElementById('status').textContent=r.ok?'Saved securely.':'Could not save variable.';if(r.ok){document.getElementById('name').value='';document.getElementById('value').value='';await load()}}async function importEnv(){let f=document.getElementById('envfile').files[0];if(!f)return;let lines=(await f.text()).split(/\\r?\\n/).filter(x=>x.trim()&&!x.trim().startsWith('#'));let failed=0;for(let line of lines){let i=line.indexOf('=');if(i<1)continue;let name=line.slice(0,i).trim();let value=line.slice(i+1).trim().replace(/^(["'])(.*)\\1$/,'$2');let r=await fetch('/api/variables',{method:'POST',headers:headers(),body:JSON.stringify({environment_id:document.getElementById('environment').value,name,value})});if(!r.ok)failed++}document.getElementById('import-status').textContent=failed?'Imported with '+failed+' invalid lines.':'Imported securely.';await load()}if(token)load();
</script></body></html>`;
