# Tracer

Personal, cloud-backed environment variables for every machine and AI coding agent.

## Deploy

```bash
npm install
npx wrangler login
npx wrangler d1 create tracer-db
# Put the returned database_id into wrangler.jsonc
npx wrangler d1 migrations apply tracer-db --remote
npx wrangler secret put TRACER_ADMIN_TOKEN
npx wrangler secret put TRACER_ENCRYPTION_KEY
npx wrangler deploy
```

Use a long random value for both secrets. The encryption key is never stored in D1. Values are encrypted with AES-GCM before storage and are only decrypted for an authenticated pull.

## CLI

```bash
node bin/tracer.mjs login https://your-worker.workers.dev YOUR_ADMIN_TOKEN
node bin/tracer.mjs pull ENVIRONMENT_ID
node bin/tracer.mjs run ENVIRONMENT_ID -- codex
```

This is an individual MVP: one admin token, one personal account, and no team sharing yet. Add OAuth/device identities before inviting other users.
