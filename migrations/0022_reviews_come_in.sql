-- What the news reader, a reader or an agent puts forward is written when it
-- comes in: the act, its report in the source, and the sender's review of it.
-- A proposal item now only links a proposal to an act it put forward, or, for
-- a search lead, to a person it names.
--
-- Columns change by adding a new one and dropping the old: acts, reviews and
-- proposal_items are referenced by other tables, so they cannot be rebuilt.

-- The news reader reviews what it finds as an agent of its own. Nobody can
-- sign in as it: the address can receive no mail.
INSERT INTO auth_users (id, name, email, emailVerified, createdAt, updatedAt, isAnonymous)
  VALUES ('news-reader', 'News reader', 'news-reader@sporelight.invalid', 0, '2026-11-26T00:00:00.000Z', '2026-11-26T00:00:00.000Z', 1);
INSERT INTO people (id, kind, display_name, created_at) VALUES ('news-reader', 'agent', 'News reader', '2026-11-26T00:00:00.000Z');

-- Proposals still waiting are dropped, with everything hanging off them, and
-- their articles are forgotten by the news search so its next run reads them
-- again. A reviewed proposal keeps a link to each act it published.
CREATE TABLE dropped_proposals AS SELECT id, source_id FROM proposals WHERE status = 'pending';
DELETE FROM article_reads WHERE outcome <> 'no_acts' AND source_id IN (SELECT source_id FROM dropped_proposals);
CREATE TABLE dropped_items AS
  SELECT i.id FROM proposal_items i
  WHERE i.proposal_id IN (SELECT id FROM dropped_proposals) OR i.status <> 'accepted' OR NOT EXISTS (SELECT 1 FROM acts a WHERE a.id = i.act_id);
DELETE FROM proposal_contexts WHERE proposal_id IN (SELECT id FROM dropped_proposals) OR proposal_item_id IN (SELECT id FROM dropped_items);
DELETE FROM proposal_mentions WHERE proposal_id IN (SELECT id FROM dropped_proposals);
DELETE FROM proposal_notes WHERE proposal_id IN (SELECT id FROM dropped_proposals);
UPDATE proposal_notes SET proposal_item_id = NULL WHERE proposal_item_id IN (SELECT id FROM dropped_items);
DELETE FROM proposal_items WHERE id IN (SELECT id FROM dropped_items);
DELETE FROM proposals WHERE id IN (SELECT id FROM dropped_proposals);
DROP TABLE dropped_items;
DROP TABLE dropped_proposals;
UPDATE proposals SET submitted_by = 'news-reader' WHERE origin IN ('model', 'news_search') AND submitted_by IS NULL;

-- The facts and the answers move to the act, its report and the reviews. On a
-- lead, act_id is null and excerpt is what the search result said: nobody's words.
DROP INDEX proposal_items_act;
ALTER TABLE proposal_items ADD COLUMN act TEXT REFERENCES acts(id);
UPDATE proposal_items SET act = act_id;
ALTER TABLE proposal_items DROP COLUMN act_id;
ALTER TABLE proposal_items RENAME COLUMN act TO act_id;
CREATE INDEX proposal_items_act ON proposal_items(act_id);
ALTER TABLE proposal_items ADD COLUMN excerpt TEXT;
ALTER TABLE proposal_items DROP COLUMN kind;
ALTER TABLE proposal_items DROP COLUMN occurred_on;
ALTER TABLE proposal_items DROP COLUMN quote;
ALTER TABLE proposal_items DROP COLUMN reading;
ALTER TABLE proposal_items DROP COLUMN weight;
ALTER TABLE proposal_items DROP COLUMN passage;
ALTER TABLE proposal_items DROP COLUMN status;

-- An act whose date has not been found yet is kept, and shown as undated, but
-- does not count toward a position until it is dated.
ALTER TABLE acts ADD COLUMN occurred TEXT;
UPDATE acts SET occurred = occurred_on;
ALTER TABLE acts DROP COLUMN occurred_on;
ALTER TABLE acts RENAME COLUMN occurred TO occurred_on;

-- A review with no position and no weight says the act says nothing on the
-- question. An editors' one takes the act off the question without touching
-- anyone else's review.
ALTER TABLE reviews ADD COLUMN shows TEXT CHECK (shows IN ('support', 'lean_support', 'mixed', 'oppose'));
ALTER TABLE reviews ADD COLUMN counts TEXT CHECK (counts IN ('presumed', 'passing', 'clear', 'concrete'));
UPDATE reviews SET shows = position, counts = weight;
ALTER TABLE reviews DROP COLUMN position;
ALTER TABLE reviews DROP COLUMN weight;
ALTER TABLE reviews RENAME COLUMN shows TO position;
ALTER TABLE reviews RENAME COLUMN counts TO weight;
