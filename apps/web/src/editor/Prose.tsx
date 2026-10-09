import type { ReactNode } from "react";

// A small, safe renderer for the assistant's replies: paragraphs, bullet and
// numbered lists, fenced code, `inline code` and **bold**. It builds React
// elements only (no HTML injection), so model output can never become markup.

function inline(text: string, keyBase: string): ReactNode[] {
    const out: ReactNode[] = [];
    const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
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
    let list: { ordered: boolean; items: string[] } | null = null;
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
        blocks.push(list.ordered ? <ol key={k++}>{items}</ol> : <ul key={k++}>{items}</ul>);
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
        const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
        const heading = line.match(/^#{1,4}\s+(.*)$/);
        if (bullet || numbered) {
            flushPara();
            const ordered = Boolean(numbered);
            if (list && list.ordered !== ordered) flushList();
            list ??= { ordered, items: [] };
            list.items.push((bullet ?? numbered)?.[1] ?? "");
        } else if (heading) {
            flushPara();
            flushList();
            blocks.push(
                <p key={k++}>
                    <strong>{heading[1]}</strong>
                </p>,
            );
        } else if (!line.trim()) {
            flushPara();
            flushList();
        } else {
            flushList();
            para.push(line.trim());
        }
    }
    if (code) blocks.push(<pre key={k++}>{(code as string[]).join("\n")}</pre>);
    flushPara();
    flushList();

    return <div className="prose">{blocks}</div>;
}
