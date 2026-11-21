-- One row per run of the news search, scheduled or started by an editor. Not
-- synced to browsers.
CREATE TABLE news_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  started_by TEXT NOT NULL CHECK (started_by IN ('cron', 'editor')),
  -- skipped: the scheduled run held back because the queue is unattended
  -- searched: the search ran to the end; `detail` holds its report
  -- stopped: the search ran but reported an error, such as a failed search or model call; `detail` holds its report
  -- failed: the run threw; `detail` holds the error
  outcome TEXT NOT NULL CHECK (outcome IN ('skipped', 'searched', 'stopped', 'failed')),
  detail TEXT
);
