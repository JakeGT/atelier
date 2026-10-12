-- Reports Atelier makes about itself: a screen that stopped working, an error nothing
-- caught, a page that froze, a save that was unusually large. They sit with the reports
-- from people and from the assistant, for whoever runs Atelier to read.
--
-- The same thing happening again is one report that counts, not a new one each time:
-- `signature` says what happened, and there is at most one open report for each.
ALTER TABLE feedback_reports DROP CONSTRAINT IF EXISTS feedback_reports_source_check;
ALTER TABLE feedback_reports ADD CONSTRAINT feedback_reports_source_check CHECK (source IN ('person', 'assistant', 'app'));
ALTER TABLE feedback_reports ADD COLUMN IF NOT EXISTS signature text;
ALTER TABLE feedback_reports ADD COLUMN IF NOT EXISTS seen integer NOT NULL DEFAULT 1;
ALTER TABLE feedback_reports ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS feedback_reports_open_signature ON feedback_reports (signature)
    WHERE status = 'open' AND signature IS NOT NULL;
