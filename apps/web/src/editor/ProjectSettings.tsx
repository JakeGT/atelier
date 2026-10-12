import { Archive, ArchiveRestore } from "lucide-react";
import type { FormEvent } from "react";
import { useCallback, useEffect, useState } from "react";
import type { Org, OrgApi, Project, ProjectMember } from "../lib/api";
import { can, ReauthRequired, reauthenticate } from "../lib/api";
import { navigate } from "../lib/hooks";
import { Dialog, Dots, useToast } from "../ui/kit";
import { ModelPicker } from "../ui/ModelPicker";
import { AskLevelSlider } from "./Asking";

interface Props {
    project: Project;
    org: Org;
    api: OrgApi;
    onClose: () => void;
    onSaved: (project: Project) => void;
    // How much the assistant asks on this website; changed at once, not with Save.
    askLevel?: number;
    onAskLevel?: (level: number) => void;
}

// A website's own settings: its name, what the assistant should keep in mind for
// it, and putting it away. Deleting lives on the studio page, behind archiving.
export function ProjectSettings({ project, org, api, onClose, onSaved, askLevel, onAskLevel }: Props) {
    const toast = useToast();
    const [name, setName] = useState(project.name);
    const [instructions, setInstructions] = useState(project.agentInstructions ?? "");
    const [model, setModel] = useState(project.agentModel);
    const [busy, setBusy] = useState(false);
    const archived = project.archivedAt !== null;
    const dirty = name.trim() !== project.name || instructions.trim() !== (project.agentInstructions ?? "") || model !== project.agentModel;

    async function save(e: FormEvent) {
        e.preventDefault();
        if (!name.trim() || busy) return;
        setBusy(true);
        try {
            const next = await api.updateProject(project.id, {
                name: name.trim(),
                agentInstructions: instructions.trim() || null,
                agentModel: model,
            });
            toast("Saved.");
            onSaved(next);
        } catch (err) {
            toast((err as Error).message, "error");
            setBusy(false);
        }
    }

    async function setArchived(next: boolean) {
        setBusy(true);
        try {
            if (next) {
                await api.archiveProject(project.id);
                toast(`${project.name} is archived. You can restore it from the studio page.`);
                navigate(`/o/${org.slug}`);
            } else {
                onSaved(await api.restoreProject(project.id));
                toast(`${project.name} is back.`);
                // The editor needs its workspace again.
                window.location.reload();
            }
        } catch (err) {
            toast((err as Error).message, "error");
            setBusy(false);
        }
    }

    return (
        <Dialog onClose={onClose} wide>
            <form onSubmit={save}>
                <p className="eyebrow">Website settings</p>
                <h2>{project.name}</h2>

                <label className="field-line">
                    <span className="eyebrow">Name</span>
                    <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} disabled={archived} />
                </label>

                <label className="field-line">
                    <span className="eyebrow">Notes for your assistant</span>
                    <textarea
                        value={instructions}
                        onChange={(e) => setInstructions(e.target.value)}
                        rows={6}
                        maxLength={8000}
                        disabled={archived}
                        placeholder={
                            "Things it should always keep in mind for this website. For example:\nWrite in British English. Our brand colour is deep green. Never mention prices."
                        }
                    />
                    <span className="field-help">
                        Your assistant reads these before every request, along with the studio's house rules.
                    </span>
                </label>

                {onAskLevel && (
                    <div className="field">
                        <AskLevelSlider
                            level={askLevel ?? 1}
                            onChange={onAskLevel}
                            disabled={archived || !can.edit(project.myRole ?? org.role)}
                            full
                        />
                    </div>
                )}

                <div className="field-line">
                    <span className="eyebrow">Assistant model</span>
                    <ModelPicker
                        api={api}
                        orgSlug={org.slug}
                        value={model}
                        onChange={setModel}
                        automatic={
                            org.defaultModel
                                ? `Studio default (${org.defaultModel.slice(org.defaultModel.indexOf("/") + 1)})`
                                : "Studio default (the built-in model)"
                        }
                        automaticHint="Whatever the studio is set to use"
                        mayManage={can.manage(org.role)}
                        disabled={archived}
                    />
                </div>

                {can.manage(org.role) && !archived && <People api={api} project={project} />}

                <p className="field-help settings-note">
                    {archived
                        ? "This website is archived: it is hidden and cannot be changed. Restore it to work on it again."
                        : "Archiving hides this website and stops its assistant. Nothing is deleted, a published website stays public, and you can restore it from the websites page. To delete it for good, use More on its card there."}
                </p>
                <div className="dialog-actions dialog-actions-split">
                    {archived ? (
                        <button type="button" className="btn" onClick={() => void setArchived(false)} disabled={busy}>
                            <ArchiveRestore /> Restore website
                        </button>
                    ) : (
                        <button
                            type="button"
                            className="btn btn-danger"
                            onClick={() => void setArchived(true)}
                            disabled={busy}
                            title="Hide this website and stop its workspace. Nothing is deleted."
                        >
                            <Archive /> Archive
                        </button>
                    )}
                    <span>
                        <button type="button" className="btn" onClick={onClose}>
                            Close
                        </button>
                        {!archived && (
                            <button type="submit" className="btn btn-primary" disabled={busy || !dirty || !name.trim()}>
                                {busy ? <Dots /> : "Save"}
                            </button>
                        )}
                    </span>
                </div>
            </form>
        </Dialog>
    );
}

// Who can do what on this website. Everyone in the studio is listed; an editor or
// a viewer can be given a different role here than they have in the studio.
function People({ api, project }: { api: OrgApi; project: Project }) {
    const toast = useToast();
    const [members, setMembers] = useState<ProjectMember[] | null>(null);
    const load = useCallback(() => api.projectMembers(project.id).then(setMembers, () => setMembers([])), [api, project.id]);
    useEffect(() => {
        void load();
    }, [load]);
    const word: Record<string, string> = { owner: "Owner", admin: "Admin", editor: "Editor", viewer: "Viewer" };
    const can: Record<string, string> = {
        owner: "everything",
        admin: "edit, publish and manage",
        editor: "edit, but not publish",
        viewer: "look, but not change anything",
    };

    async function change(m: ProjectMember, value: string) {
        try {
            await api.setProjectRole(project.id, m.userId, value === "studio" ? null : (value as "admin" | "editor" | "viewer"));
            toast(
                value === "studio"
                    ? `${m.name} has their studio role here again.`
                    : `${m.name} is now ${value === "editor" || value === "admin" ? "an" : "a"} ${value} on this website.`,
            );
        } catch (err) {
            if (err instanceof ReauthRequired) {
                toast("Please confirm your sign-in, then try that again.", "error");
                setTimeout(reauthenticate, 1400);
            } else toast((err as Error).message, "error");
        }
        await load();
    }

    return (
        <div className="field-line">
            <span className="eyebrow">Who can do what on this website</span>
            {members === null ? (
                <Dots />
            ) : (
                <ul className="people">
                    {members.map((m) => (
                        <li key={m.userId}>
                            <span className="people-name">
                                <strong>{m.name}</strong>
                                <span className="muted">Can {can[m.role]}</span>
                            </span>
                            {m.fixed ? (
                                <span className="chip chip-plain" title="Owners and admins have the same role on every website">
                                    {word[m.role]} everywhere
                                </span>
                            ) : (
                                <select
                                    value={m.differs ? m.role : "studio"}
                                    onChange={(e) => void change(m, e.target.value)}
                                    aria-label={`Role of ${m.name} on this website`}
                                >
                                    <option value="studio">Same as in the studio ({word[m.studioRole]})</option>
                                    {(["viewer", "editor", "admin"] as const)
                                        .filter((r) => r !== m.studioRole)
                                        .map((r) => (
                                            <option key={r} value={r}>
                                                {word[r]} on this website
                                            </option>
                                        ))}
                                </select>
                            )}
                        </li>
                    ))}
                </ul>
            )}
            <span className="field-help">
                People are added to the studio in its settings. Here you can give an editor or a viewer a different role on this one
                website.
            </span>
        </div>
    );
}
