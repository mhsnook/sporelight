-- A run's row is now written when it starts, as `running`, and updated when it
-- ends. Its steps are written as it goes, so an editor can follow a run and
-- read it back later. Neither table is synced to browsers; editors read them
-- through the Worker.
CREATE TABLE news_runs_next (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  started_by TEXT NOT NULL CHECK (started_by IN ('cron', 'editor')),
  -- running: not finished, or the Worker running it stopped before it could say
  -- skipped: the scheduled run held back because the queue is unattended; `detail` says why
  -- searched: the search ran to the end; `detail` holds its report
  -- stopped: the search ran but reported an error, such as a failed search or model call; `detail` holds its report
  -- failed: the run threw; `detail` holds the error
  outcome TEXT NOT NULL CHECK (outcome IN ('running', 'skipped', 'searched', 'stopped', 'failed')),
  finished_at TEXT,
  detail TEXT
);
INSERT INTO news_runs_next (id, started_at, started_by, outcome, finished_at, detail)
  SELECT id, started_at, started_by, outcome, NULL, detail FROM news_runs;
DROP TABLE news_runs;
ALTER TABLE news_runs_next RENAME TO news_runs;
CREATE INDEX news_runs_by_start ON news_runs (started_at);

-- One row per step a run reported, in order. `step` is the JSON of a NewsStep (shared/news-run.ts).
CREATE TABLE news_run_steps (
  run_id TEXT NOT NULL REFERENCES news_runs (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  at TEXT NOT NULL,
  step TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);
