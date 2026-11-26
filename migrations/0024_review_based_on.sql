-- A review made by confirming someone else's points at it. Deleting that one
-- leaves the copy standing, with nothing to point at. The column changes in
-- place: reviews is referenced by itself, so it cannot be rebuilt.
ALTER TABLE reviews ADD COLUMN started_from TEXT REFERENCES reviews(id) ON DELETE SET NULL;
UPDATE reviews SET started_from = based_on;
ALTER TABLE reviews DROP COLUMN based_on;
ALTER TABLE reviews RENAME COLUMN started_from TO based_on;
CREATE INDEX reviews_based_on ON reviews(based_on);
