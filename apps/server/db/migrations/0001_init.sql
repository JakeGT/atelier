-- OIDC accounts, matched by (issuer, subject). The full tenancy schema
-- (control.tenants, organizations, projects, content, releases) lands in P1/P2.
CREATE TABLE IF NOT EXISTS users (
    id uuid PRIMARY KEY,
    issuer text NOT NULL,
    subject text NOT NULL,
    email text NOT NULL,
    name text NOT NULL,
    admin boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (issuer, subject)
);
