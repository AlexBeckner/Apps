-- Surface the tagger of annotated tags in the dashboard (the Tags table
-- "Tagger" column and the tag detail page). Lightweight tags have no tagger, so
-- these stay NULL for them. The existing `message` column is unchanged here; the
-- tag ingest now stores the full annotation message (subject + body) in it so a
-- tag message reads like a PR description.
ALTER TABLE tags ADD COLUMN tagger_name TEXT;
ALTER TABLE tags ADD COLUMN tagger_email TEXT;
