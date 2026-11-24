-- Removes every body marked is_demo and what hangs off it: its seats, its
-- questions, the people who sit only in such bodies, their record, what readers
-- sent in about them, and the sources nothing else cites. Changes nothing in a
-- database with no demo body. It writes past the sync log, like seeding, so
-- open pages show the rows until they reload.

CREATE TABLE removed_bodies AS SELECT id FROM bodies WHERE is_demo = 1;
CREATE TABLE removed_questions AS SELECT id FROM questions WHERE body_id IN (SELECT id FROM removed_bodies);
-- Someone who also sits in a real body stays.
CREATE TABLE removed_deciders AS
  SELECT d.id FROM deciders d
  WHERE EXISTS (SELECT 1 FROM roles r JOIN seats s ON s.id = r.seat_id WHERE r.decider_id = d.id AND s.body_id IN (SELECT id FROM removed_bodies))
    AND NOT EXISTS (SELECT 1 FROM roles r JOIN seats s ON s.id = r.seat_id WHERE r.decider_id = d.id AND s.body_id NOT IN (SELECT id FROM removed_bodies));
-- An office at large goes when everyone who has held it does.
CREATE TABLE removed_offices AS
  SELECT o.id FROM offices o
  WHERE o.body_id IN (SELECT id FROM removed_bodies)
     OR (EXISTS (SELECT 1 FROM office_holders h WHERE h.office_id = o.id)
         AND NOT EXISTS (SELECT 1 FROM office_holders h WHERE h.office_id = o.id AND h.decider_id NOT IN (SELECT id FROM removed_deciders)));
CREATE TABLE removed_acts AS SELECT id FROM acts WHERE decider_id IN (SELECT id FROM removed_deciders);
CREATE TABLE removed_items AS
  SELECT id, proposal_id FROM proposal_items
  WHERE decider_id IN (SELECT id FROM removed_deciders) OR question_id IN (SELECT id FROM removed_questions);
-- Sources these rows cite. One is deleted only if nothing cites it afterwards.
CREATE TABLE removed_sources AS
  SELECT source_id AS id FROM reports WHERE act_id IN (SELECT id FROM removed_acts)
  UNION SELECT primary_source_id FROM acts WHERE id IN (SELECT id FROM removed_acts) AND primary_source_id IS NOT NULL
  UNION SELECT source_id FROM proposals WHERE id IN (SELECT proposal_id FROM removed_items)
  UNION SELECT source_id FROM office_holders WHERE decider_id IN (SELECT id FROM removed_deciders) AND source_id IS NOT NULL;

-- A comment thread is named "<question id>:<decider id>".
DELETE FROM comments WHERE thread_id IN (SELECT q.id || ':' || d.id FROM removed_questions q, deciders d)
   OR thread_id IN (SELECT q.id || ':' || d.id FROM questions q, removed_deciders d);

DELETE FROM proposal_mentions WHERE decider_id IN (SELECT id FROM removed_deciders);
DELETE FROM proposal_contexts WHERE proposal_item_id IN (SELECT id FROM removed_items);
DELETE FROM proposal_notes WHERE proposal_item_id IN (SELECT id FROM removed_items);
DELETE FROM proposal_items WHERE id IN (SELECT id FROM removed_items);
DELETE FROM proposal_notes WHERE proposal_id IN (SELECT proposal_id FROM removed_items)
  AND NOT EXISTS (SELECT 1 FROM proposal_items i WHERE i.proposal_id = proposal_notes.proposal_id);
DELETE FROM proposal_mentions WHERE proposal_id IN (SELECT proposal_id FROM removed_items)
  AND NOT EXISTS (SELECT 1 FROM proposal_items i WHERE i.proposal_id = proposal_mentions.proposal_id);
DELETE FROM proposals WHERE id IN (SELECT proposal_id FROM removed_items)
  AND NOT EXISTS (SELECT 1 FROM proposal_items i WHERE i.proposal_id = proposals.id);

DELETE FROM reviews WHERE act_id IN (SELECT id FROM removed_acts) OR question_id IN (SELECT id FROM removed_questions);
DELETE FROM reports WHERE act_id IN (SELECT id FROM removed_acts);
DELETE FROM acts WHERE id IN (SELECT id FROM removed_acts);
DELETE FROM set_positions WHERE question_id IN (SELECT id FROM removed_questions) OR decider_id IN (SELECT id FROM removed_deciders);
DELETE FROM question_relations WHERE question_id IN (SELECT id FROM removed_questions) OR related_id IN (SELECT id FROM removed_questions);
DELETE FROM question_deciders WHERE question_id IN (SELECT id FROM removed_questions) OR decider_id IN (SELECT id FROM removed_deciders);
DELETE FROM question_offices WHERE question_id IN (SELECT id FROM removed_questions) OR office_id IN (SELECT id FROM removed_offices);
DELETE FROM question_bodies WHERE question_id IN (SELECT id FROM removed_questions) OR body_id IN (SELECT id FROM removed_bodies);
DELETE FROM article_reads WHERE question_id IN (SELECT id FROM removed_questions);
DELETE FROM office_holders WHERE decider_id IN (SELECT id FROM removed_deciders) OR office_id IN (SELECT id FROM removed_offices);
DELETE FROM offices WHERE id IN (SELECT id FROM removed_offices);
DELETE FROM questions WHERE id IN (SELECT id FROM removed_questions);
DELETE FROM roles WHERE decider_id IN (SELECT id FROM removed_deciders)
   OR seat_id IN (SELECT id FROM seats WHERE body_id IN (SELECT id FROM removed_bodies));
DELETE FROM seats WHERE body_id IN (SELECT id FROM removed_bodies);
DELETE FROM deciders WHERE id IN (SELECT id FROM removed_deciders);
DELETE FROM sources WHERE id IN (SELECT id FROM removed_sources)
  AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.source_id = sources.id)
  AND NOT EXISTS (SELECT 1 FROM acts a WHERE a.primary_source_id = sources.id)
  AND NOT EXISTS (SELECT 1 FROM proposals p WHERE p.source_id = sources.id)
  AND NOT EXISTS (SELECT 1 FROM article_reads r WHERE r.source_id = sources.id)
  AND NOT EXISTS (SELECT 1 FROM office_holders h WHERE h.source_id = sources.id);
DELETE FROM archive_attempts WHERE source_id IN (SELECT id FROM removed_sources) AND source_id NOT IN (SELECT id FROM sources);
DELETE FROM bodies WHERE id IN (SELECT id FROM removed_bodies);

DROP TABLE removed_sources;
DROP TABLE removed_items;
DROP TABLE removed_acts;
DROP TABLE removed_offices;
DROP TABLE removed_deciders;
DROP TABLE removed_questions;
DROP TABLE removed_bodies;
