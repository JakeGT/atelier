import { Archive, ArchiveRestore } from "lucide-react";
import type { FormEvent } from "react";
import { useState } from "react";
import type { Org, OrgApi, Project } from "../lib/api";
import { navigate } from "../lib/hooks";
import { Dialog, Dots, useToast } from "../ui/kit";

interface Props {
    project: Project;
    org: Org;
    api: OrgApi;
    onClose: () => void;
    onSaved: (project: Project) => void;
}

// A website's own settings: its name, what the assistant should keep in mind for
// it, and putting it away. Deleting lives on the studio page, behind archiving.
export function ProjectSettings({ project, org, api, onClose, onSaved }: Props) {
    const toast = useToast();
    const [name, setName] = useState(project.name);
    const [instructions, setInstructions] = useState(project.agentInstructions ?? "");
    const [model, setModel] = useState(project.agentModel ?? "");
    const [busy, setBusy] = useState(false);
    const archived = project.archivedAt !== null;
    const dirty =
        name.trim() !== project.name ||
        instructions.trim() !== (project.agentInstructions ?? "") ||
        model.trim() !== (project.agentModel ?? "");

    async function save(e: FormEvent) {
        e.preventDefault();
        if (!name.trim() || busy) return;
        setBusy(true);
        try {
            const next = await api.updateProject(project.id, {
                name: name.trim(),
                agentInstructions: instructions.trim() || null,
                agentModel: model.trim() || null,
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

                <label className="field-line">
                    <span className="eyebrow">Assistant model</span>
                    <input
                        value={model}
                        onChange={(e) => setModel(e.target.value)}
                        placeholder={org.defaultModel ? `Studio default (${org.defaultModel})` : "Automatic"}
                        maxLength={120}
                        className="mono"
                        disabled={archived}
                    />
                </label>

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
