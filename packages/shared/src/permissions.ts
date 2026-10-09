import type { OrgRole } from "./types.ts";

// The single source of truth for what an actor may do, shared by the server and
// the web app so gating is identical on both sides. Every route and MCP tool
// declares the permission it requires; CI fails if one does not.

export const PERMISSIONS = [
    // organization & membership
    "org.read",
    "org.manage",
    "org.members",
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

// Which capabilities each organization role grants. Viewer is read-mostly,
// editor can change content and code, admin adds management, owner is the
// billing + membership authority.
export const ROLE_PERMISSIONS: Record<OrgRole, readonly Permission[]> = {
    viewer: ["org.read", "project.read", "content.read", "release.read", "session.open"],
    editor: ["org.read", "project.read", "content.read", "content.write", "media.write", "project.edit", "session.open", "release.read"],
    admin: [
        "org.read",
        "org.manage",
        "org.members",
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
    ],
    owner: [
        "org.read",
        "org.manage",
        "org.members",
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
    ],
};

// Platform operators (Authentik platform-admin) get these regardless of org role.
export const OPERATOR_PERMISSIONS: readonly Permission[] = ["admin.tenants", "admin.audit"];

export function hasPermission(role: OrgRole, permission: Permission): boolean {
    return ROLE_PERMISSIONS[role].includes(permission);
}

export function hasOperatorPermission(permission: Permission): boolean {
    return OPERATOR_PERMISSIONS.includes(permission);
}
