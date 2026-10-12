import type { OrgRole } from "./types.ts";

// The single source of truth for what an actor may do, shared by the server and
// the web app so gating is identical on both sides. Every route and MCP tool
// declares the permission it requires; CI fails if one does not.

export const PERMISSIONS = [
    // organization & membership
    "org.read",
    "org.manage",
    "org.members",
    // deleting the studio itself, and downloading everything in it: the owner only
    "org.delete",
    // the studio's own API keys for model providers (BYOK)
    "secrets.manage",
    // projects
    "project.read",
    "project.create",
    "project.manage",
    "project.archive",
    "project.delete",
    // editing
    "project.edit",
    "content.read",
    "content.write",
    "media.write",
    "session.open",
    // release
    "release.read",
    "release.publish",
    "release.rollback",
    // domains / deploy
    "domain.manage",
    // operator-only
    "admin.tenants",
    "admin.audit",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ADMIN_PERMISSIONS: readonly Permission[] = [
    "org.read",
    "org.manage",
    "org.members",
    "secrets.manage",
    "project.read",
    "project.create",
    "project.manage",
    "project.archive",
    "project.delete",
    "content.read",
    "content.write",
    "media.write",
    "project.edit",
    "session.open",
    "release.read",
    "release.publish",
    "release.rollback",
    "domain.manage",
];

// Which capabilities each organization role grants. Viewer is read-mostly,
// editor can change content and code, admin adds management, owner is the
// billing + membership authority.
export const ROLE_PERMISSIONS: Record<OrgRole, readonly Permission[]> = {
    viewer: ["org.read", "project.read", "content.read", "release.read", "session.open"],
    editor: ["org.read", "project.read", "content.read", "content.write", "media.write", "project.edit", "session.open", "release.read"],
    admin: ADMIN_PERMISSIONS,
    // Everything an admin may do, and deleting the studio.
    owner: ["org.delete", ...ADMIN_PERMISSIONS],
};

// Platform operators (Authentik platform-admin) get these regardless of org role.
export const OPERATOR_PERMISSIONS: readonly Permission[] = ["admin.tenants", "admin.audit"];

export function hasPermission(role: OrgRole, permission: Permission): boolean {
    // A role this version does not know (an old row, a newer server) may do nothing.
    return (ROLE_PERMISSIONS as Record<string, readonly Permission[] | undefined>)[role]?.includes(permission) ?? false;
}

export function hasOperatorPermission(permission: Permission): boolean {
    return OPERATOR_PERMISSIONS.includes(permission);
}
