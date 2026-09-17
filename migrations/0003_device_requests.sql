CREATE TABLE IF NOT EXISTS device_requests (
  id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL UNIQUE,
  token_ciphertext TEXT,
  expires_at TEXT NOT NULL
);
