import type { ContentDocument } from "@atelier/shared";

// What must be right before a website is published (ADR-0014 §3). Checked then,
// not while writing: a draft is allowed to be unfinished.

const plain = (html: string): string =>
    html
        .replace(/<[^>]*>/g, " ")
        .replace(/&nbsp;/g, " ")
        .trim();

function empty(field: { type: string }, value: unknown): boolean {
    if (value === undefined || value === null) return true;
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value !== "string") return false;
    return (field.type === "rich" ? plain(value) : value.trim()) === "";
}

const pageName = (d: Pick<ContentDocument, "slug">): string =>
    d.slug === "shared" ? "on every page" : `on the ${d.slug.replace(/[-_]+/g, " ")} page`;

// One sentence per problem, in the person's words.
export function contentProblems(documents: Pick<ContentDocument, "kind" | "slug" | "draft" | "fields">[]): string[] {
    const problems: string[] = [];
    for (const doc of documents) {
        const where = pageName(doc);
        for (const field of doc.fields ?? []) {
            const value = doc.draft?.[field.key];
            if (field.required && empty(field, value)) problems.push(`“${field.label}” ${where} is empty`);
            if (field.max && typeof value === "string" && (field.type === "text" || field.type === "long") && value.length > field.max)
                problems.push(`“${field.label}” ${where} is ${value.length} characters long; the most it can be is ${field.max}`);
            if (field.max && Array.isArray(value) && value.length > field.max)
                problems.push(`“${field.label}” ${where} has ${value.length} entries; the most it can have is ${field.max}`);
            if (field.type !== "items" || !Array.isArray(value)) continue;
            value.forEach((entry, i) => {
                if (!entry || typeof entry !== "object") return;
                for (const part of field.itemFields ?? []) {
                    const v = (entry as Record<string, unknown>)[part.key];
                    if (part.required && empty(part, v))
                        problems.push(`“${part.label}” is empty in entry ${i + 1} of “${field.label}” ${where}`);
                    if (part.max && typeof v === "string" && (part.type === "text" || part.type === "long") && v.length > part.max)
                        problems.push(
                            `“${part.label}” in entry ${i + 1} of “${field.label}” ${where} is longer than ${part.max} characters`,
                        );
                }
            });
        }
    }
    return problems;
}
