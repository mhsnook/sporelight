-- Where a source's publish date came from: 'search' (the search provider's
-- date for the result), 'page' (the page's own metadata) or 'editor'. Until
-- now only an editor or the seed could have set `published_on`, so a date
-- already there is an editor's.
ALTER TABLE sources ADD COLUMN published_on_from TEXT CHECK (published_on_from IN ('search', 'page', 'editor'));
UPDATE sources SET published_on_from = 'editor' WHERE published_on IS NOT NULL;
