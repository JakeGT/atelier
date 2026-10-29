-- An operator of this Atelier inside a studio they do not belong to, for support
-- (ADR-0021). Each visit is asked for, lasts a limited time, and is written to the
-- studio's activity and told to its owners. Like the audit log this looks across
-- studios, so it is not tenant-scoped; only operator code reads it.
CREATE TABLE IF NOT EXISTS operator_visits (
    user_id uuid NOT NULL,
    studio_id uuid NOT NULL,
    started_at timestamptz NOT NULL DEFAULT now(),
    until timestamptz NOT NULL,
    PRIMARY KEY (user_id, studio_id)
);
