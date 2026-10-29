-- Where the subject of a picture is (so a crop keeps it in view), and a video's
-- still picture.
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS focal_x real;
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS focal_y real;
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS poster text;
