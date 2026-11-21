-- One row per run of the news search, scheduled or started by an editor, with
-- what came of it, so a run that read nothing can be told apart from one that
-- never ran. Not synced to browsers.
CREATE TABLE news_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  started_by TEXT NOT NULL CHECK (started_by IN ('cron', 'editor')),
  -- skipped: the scheduled run held back because the queue is unattended
  -- searched: the search ran; `detail` holds its report, which may carry an error
  -- failed: the run threw; `detail` holds the error
  outcome TEXT NOT NULL CHECK (outcome IN ('skipped', 'searched', 'failed')),
  detail TEXT
);
CREATE INDEX news_runs_started_at ON news_runs(started_at);
