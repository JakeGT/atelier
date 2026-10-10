-- Everyone has one personal studio, made when they first arrive, and goes through
-- a short introduction once. Access to Atelier itself is decided by the identity
-- provider (who may sign in at all); Atelier no longer gates it.
--
-- `personal_of`: the person whose personal studio this is (at most one each).
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS personal_of uuid REFERENCES users(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS organizations_personal_of ON organizations (personal_of) WHERE personal_of IS NOT NULL;

-- When the person finished (or skipped) the introduction. People who were already
-- here have no need of it. Which of their studios is the personal one is settled
-- the next time they sign in (services/bootstrap.ts), since row-level security
-- keeps a migration from reading memberships.
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarded_at timestamptz;
UPDATE users SET onboarded_at = now() WHERE onboarded_at IS NULL;
