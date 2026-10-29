-- A picture of each website's home page, for its card on the studio page.
-- Taken in the website's workspace after a change and kept with its media;
-- this records when, so a card knows there is one and which one it has seen.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS cover_at timestamptz;
