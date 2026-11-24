-- Every article the news search reads is kept as a source, whatever the model
-- found in it, and each read points at its source rather than holding a URL.
-- A read with no source yet gets one here, with no title or date. Rows written
-- here skip the sync log: a browser sees them on its next full load.
INSERT INTO sources (id, url, created_at)
  SELECT 'read-' || lower(hex(randomblob(16))), r.url, MIN(r.read_at)
  FROM article_reads r
  WHERE NOT EXISTS (SELECT 1 FROM sources s WHERE s.url = r.url)
  GROUP BY r.url;

CREATE TABLE article_reads_next (
  source_id TEXT NOT NULL REFERENCES sources (id),
  question_id TEXT NOT NULL REFERENCES questions (id),
  read_at TEXT NOT NULL,
  -- queued: acts were found and queued
  -- no_acts: the model read it and found nothing that survived the quote check
  -- not_read: the article could not be fetched, or the model failed; the search excerpt was queued instead
  outcome TEXT NOT NULL CHECK (outcome IN ('queued', 'no_acts', 'not_read')),
  model TEXT,
  detail TEXT,
  PRIMARY KEY (source_id, question_id)
);
INSERT INTO article_reads_next (source_id, question_id, read_at, outcome, model, detail)
  SELECT s.id, r.question_id, r.read_at, r.outcome, r.model, r.detail FROM article_reads r JOIN sources s ON s.url = r.url;
DROP TABLE article_reads;
ALTER TABLE article_reads_next RENAME TO article_reads;
