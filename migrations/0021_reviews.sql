-- Each judgement of what an act shows on a question is a review, owned by the
-- identity that made it. What an act reads as on a question is worked out from
-- its reviews and is not stored.

-- Until editors are signed-in people, everything written with the editor token
-- is written as this one identity. The address can receive no mail, so nobody
-- can sign in as it.
INSERT INTO auth_users (id, name, email, emailVerified, createdAt, updatedAt, isAnonymous)
  VALUES ('editors', 'Editors', 'editors@sporelight.invalid', 0, '2026-11-24T00:00:00.000Z', '2026-11-24T00:00:00.000Z', 0);
INSERT INTO people (id, kind, display_name, created_at) VALUES ('editors', 'person', 'Editors', '2026-11-24T00:00:00.000Z');

CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  reviewer_id TEXT NOT NULL REFERENCES people(id),
  act_id TEXT NOT NULL REFERENCES acts(id),
  question_id TEXT NOT NULL REFERENCES questions(id),
  position TEXT NOT NULL CHECK (position IN ('support', 'lean_support', 'mixed', 'oppose')),
  weight TEXT NOT NULL CHECK (weight IN ('presumed', 'passing', 'clear', 'concrete')),
  -- The review this one started from, when it was made from someone else's.
  based_on TEXT REFERENCES reviews(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (reviewer_id, act_id, question_id)
);
CREATE INDEX reviews_act ON reviews(act_id);
CREATE INDEX reviews_question ON reviews(question_id);

-- One act an editor has found to be the same real-world act as another. Both
-- acts and everything pointing at them stay; the record shows the first as the
-- second, and deleting the row separates them again.
CREATE TABLE same_acts (
  act_id TEXT PRIMARY KEY REFERENCES acts(id),
  same_as_id TEXT NOT NULL REFERENCES acts(id),
  marked_by TEXT NOT NULL REFERENCES people(id),
  marked_at TEXT NOT NULL,
  CHECK (act_id <> same_as_id)
);
CREATE INDEX same_acts_same_as ON same_acts(same_as_id);

-- Every reading so far was an editor's. One a sub-question implied is dropped:
-- it is worked out again from the reading on the sub-question. A lean against
-- left from before 0012 becomes a passing reading against, as 0012 made them.
INSERT INTO reviews (id, reviewer_id, act_id, question_id, position, weight, based_on, created_at, updated_at)
  SELECT id, 'editors', act_id, question_id,
    CASE WHEN position = 'lean_oppose' THEN 'oppose' ELSE position END,
    CASE WHEN position = 'lean_oppose' AND weight = 'clear' THEN 'passing' ELSE weight END,
    NULL, created_at, created_at
  FROM readings WHERE via_question_id IS NULL;
DROP TABLE readings;
