import type { ReactNode } from "react";

// A small, safe renderer for the assistant's replies: paragraphs, bullet and
// numbered lists, fenced code, `inline code` and **bold**. It builds React
// elements only (no HTML injection), so model output can never become markup.

function inline(text: string, keyBase: string): ReactNode[] {
    const out: ReactNode[] = [];
    // Only `code` and **bold** are marked up. Bold runs to the next "**", so a single asterisk inside it
    // ("**a *b* c**") does not stop it being bold. Anything else (*one asterisk*, a lone backtick) is shown as written.
    const re = /(`[^`]+`|\*\*.+?\*\*)/g;
    let last = 0;
    let i = 0;
    for (const m of text.matchAll(re)) {
        if (m.index > last) out.push(text.slice(last, m.index));
        const token = m[0];
        out.push(
            token.startsWith("`") ? (
                <code key={`${keyBase}-${i}`}>{token.slice(1, -1)}</code>
            ) : (
                <strong key={`${keyBase}-${i}`}>{token.slice(2, -2)}</strong>
            ),
        );
        last = m.index + token.length;
        i++;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
}

export function Prose({ text }: { text: string }) {
    const blocks: ReactNode[] = [];
    const lines = text.replace(/\r/g, "").split("\n");
    let para: string[] = [];
    // `start`: the number a numbered list begins at, so one carried on after a paragraph keeps counting.
    let list: { ordered: boolean; start: number; items: string[] } | null = null;
    let code: string[] | null = null;
    let k = 0;

    const flushPara = () => {
        if (para.length) blocks.push(<p key={k++}>{inline(para.join(" "), `p${k}`)}</p>);
        para = [];
    };
    const flushList = () => {
        if (!list) return;
        // biome-ignore lint/suspicious/noArrayIndexKey: a parsed, static list; items never reorder
        const items = list.items.map((item, i) => <li key={`${k}-${i}`}>{inline(item, `l${k}-${i}`)}</li>);
        blocks.push(
            list.ordered ? (
                <ol key={k++} start={list.start}>
                    {items}
                </ol>
            ) : (
                <ul key={k++}>{items}</ul>
            ),
        );
        list = null;
    };

    for (const line of lines) {
        if (line.trimStart().startsWith("```")) {
            if (code) {
                blocks.push(<pre key={k++}>{code.join("\n")}</pre>);
                code = null;
            } else {
                flushPara();
                flushList();
                code = [];
            }
            continue;
        }
        if (code) {
            code.push(line);
            continue;
        }
        const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
        const numbered = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
        const heading = line.match(/^#{1,4}\s+(.*)$/);
        if (bullet || numbered) {
            flushPara();
            const ordered = Boolean(numbered);
            if (list && list.ordered !== ordered) flushList();
            list ??= { ordered, start: Number(numbered?.[1] ?? 1), items: [] };
            list.items.push(bullet?.[1] ?? numbered?.[2] ?? "");
        } else if (heading) {
            flushPara();
            flushList();
            blocks.push(
                <p key={k++}>
                    <strong>{inline(heading[1] ?? "", `h${k}`)}</strong>
                </p>,
            );
        } else if (!line.trim()) {
            // A blank line ends a paragraph but not a list: entries are often written with space between them.
            flushPara();
        } else {
            flushList();
            para.push(line.trim());
        }
    }
    if (code) blocks.push(<pre key={k++}>{code.join("\n")}</pre>);
    flushPara();
    flushList();

    return <div className="prose">{blocks}</div>;
}
