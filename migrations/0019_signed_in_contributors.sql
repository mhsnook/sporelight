-- Every comment has a person, and shows that person's display_name.
DELETE FROM comments WHERE person_id IS NULL;
CREATE TABLE comments_next (
  id TEXT PRIMARY KEY,
  -- "<question_id>:<decider_id>", the same key a stance uses
  thread_id TEXT NOT NULL,
  person_id TEXT NOT NULL REFERENCES people(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
INSERT INTO comments_next (id, thread_id, person_id, body, created_at)
  SELECT id, thread_id, person_id, body, created_at FROM comments;
DROP TABLE comments;
ALTER TABLE comments_next RENAME TO comments;
CREATE INDEX comments_thread ON comments(thread_id, created_at);
CREATE INDEX comments_person ON comments(person_id);

ALTER TABLE people DROP COLUMN muted_at;
