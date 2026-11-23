-- Organisations that send evidence through the MCP endpoint. The first post
-- under an org id claims it with a secret the sender chooses; every later post
-- under that id has to carry the same secret. No collection serves this table,
-- so the secret's hash never reaches a browser. A proposal a partner sent has
-- origin 'partner' and submitted_by set to partners.id.
CREATE TABLE partners (
  id TEXT PRIMARY KEY,
  org TEXT NOT NULL UNIQUE,
  secret_salt TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL
);
