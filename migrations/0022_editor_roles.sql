-- Editors are signed-in people with the role `editor`; everyone else who signs
-- in is a `member`. Roles and deactivation are Better Auth's admin plugin: the
-- five statements on auth_ tables are what its migration generator writes for
-- SQLite. A deactivated person is banned there, which ends their sessions and
-- refuses their sign-in.
alter table "auth_users" add column "role" text;

alter table "auth_users" add column "banned" integer default 0;

alter table "auth_users" add column "banReason" text;

alter table "auth_users" add column "banExpires" date;

alter table "auth_sessions" add column "impersonatedBy" text;

UPDATE auth_users SET role = 'member';

-- The identity everything written with the retired editor token was written
-- as. It stays an editor, so its reviews still count as editors', and is
-- banned, so it does not count as an editor who can act, and nobody signs in as it.
UPDATE auth_users SET role = 'editor', banned = 1, banReason = 'The shared editor token, which this identity stood for, was retired.' WHERE id = 'editors';

-- The public copy of each person's role and whether they are deactivated, kept
-- in step with auth_users by the Worker.
ALTER TABLE people ADD COLUMN role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'editor'));
ALTER TABLE people ADD COLUMN deactivated_at TEXT;
UPDATE people SET role = 'editor', deactivated_at = '2026-11-26T00:00:00.000Z' WHERE id = 'editors';

DROP TABLE role_assignments;

-- An archived question is off /questions and out of the news search, and its page still works.
ALTER TABLE questions ADD COLUMN archived_at TEXT;

-- Who reviewed each proposal. Every review so far was made with the editor token.
ALTER TABLE proposals ADD COLUMN reviewed_by TEXT REFERENCES people(id);
UPDATE proposals SET reviewed_by = 'editors' WHERE status = 'reviewed';

-- The editors who can act. The Worker and the triggers below both read it.
CREATE VIEW active_editors AS SELECT id FROM auth_users WHERE role = 'editor' AND coalesce(banned, 0) = 0;

-- A deployment always keeps one editor who can act. Better Auth's own checks
-- run one request at a time, so two editors demoting each other at once would
-- both pass them; this check runs inside the write.
CREATE TRIGGER keep_one_editor BEFORE UPDATE OF role, banned ON auth_users
WHEN OLD.id IN (SELECT id FROM active_editors)
  AND (NEW.role IS NOT 'editor' OR coalesce(NEW.banned, 0) = 1)
  AND NOT EXISTS (SELECT 1 FROM active_editors WHERE id <> OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'last editor');
END;

CREATE TRIGGER keep_one_editor_on_delete BEFORE DELETE ON auth_users
WHEN OLD.id IN (SELECT id FROM active_editors)
  AND NOT EXISTS (SELECT 1 FROM active_editors WHERE id <> OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'last editor');
END;

-- Requests a member can start that call the archive or the model: one row per
-- tool and target while it runs, so the same request is not made twice at once,
-- and the result of a reader trial, reused for a day. A plain table, not synced.
CREATE TABLE tool_runs (
  tool TEXT NOT NULL CHECK (tool IN ('archive', 'read_article')),
  target TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  result TEXT,
  PRIMARY KEY (tool, target)
);
