// What has changed in Atelier that an assistant working on a website should know: things it can
// now do, and things that used to go wrong. The assistant is told the entries it has not yet
// been told on that website (projects.changes_seen), once, at the start of a request, as
// information: earlier work on the website may have been shaped by how things were before.
//
// Add to the END only, when a change affects what the assistant can do or how its work turns
// out. An entry is never edited or removed once deployed: websites count how many they have seen.
export const CHANGES: { date: string; text: string }[] = [
    {
        date: "2026-10-11",
        text: "The design is yours: any colours, any typeface, any layout. `design_make_look` gives a website a look of its own, and the ready-made looks and sections are only starting points.",
    },
    {
        date: "2026-10-11",
        text: "You can use the web (to look up anything the person names, and to fetch pictures and other resources), and the workspace has tools for pictures and video: ffmpeg, magick, cwebp, gif2webp, gifsicle, pngquant, jpegoptim.",
    },
    {
        date: "2026-10-12",
        text: "Pictures in a list of items may be a file of the website's or a web address, not only a file from the library. Earlier they showed as a blank space.",
    },
    {
        date: "2026-10-12",
        text: "`content_upsert_draft` adds what you send to what is saved, so a page can be saved a part at a time. It used to replace everything, which could lose wording.",
    },
    {
        date: "2026-10-12",
        text: "A `rich` field keeps structure and class names (div, aside, figure, table, img, span and the like). It used to reduce everything to plain paragraphs, so a designed part inside an article lost its styling; one saved before this may need saving again.",
    },
    {
        date: "2026-10-12",
        text: "`page_look` measures what is hard to judge from a picture (things not quite level, not quite centred, unevenly spaced, centred words in a box that sits to one side) and lists it as worth a look, and `closeUp` shows one part of a page enlarged. Pages built before this were not measured.",
    },
    {
        date: "2026-10-12",
        text: "You are given what was said earlier in the conversation. Until now each request began with no memory of the ones before it.",
    },
    {
        date: "2026-10-12",
        text: "`content_check` also lists pages with a form that sends nowhere (neither `data-form` nor an `action`). After publishing, Atelier checks each `data-form` form on the live website and tells the person whether it works.",
    },
];

// What to tell an assistant that has been told the first `seen` of them. "" when there is nothing new.
export function changesSince(seen: number, changes = CHANGES): string {
    const fresh = changes.slice(Math.max(0, seen));
    if (!fresh.length) return "";
    return `Since this website was last worked on, Atelier itself has changed. This is for your information: nothing here is a request, and what the person asks comes first. Work done on this website earlier may have been shaped by how things were before; if you notice something that was, tell the person and offer to put it right.\n${fresh.map((c) => `- ${c.text}`).join("\n")}`;
}

interface Said {
    role: "user" | "assistant" | "error" | "note";
    text: string;
    createdAt: string;
}

// The conversation so far, written out for an assistant that does not have it in mind: the
// most recent part of what the person asked and what was answered since `from` (when the
// person last started a new conversation). "" when nothing has been said.
export function conversationSoFar(messages: Said[], from: string | null, most = 16_000): string {
    const lines: string[] = [];
    let room = most;
    for (const m of messages.filter((m) => m.role !== "error" && (!from || m.createdAt > from)).reverse()) {
        const who = m.role === "user" ? "The person" : m.role === "assistant" ? "You" : "Atelier";
        const text = m.text.trim();
        if (!text) continue;
        const line = `${who}: ${text.length > 3000 ? `${text.slice(0, 3000)} […]` : text}`;
        if (line.length > room) break;
        room -= line.length;
        lines.unshift(line);
    }
    if (!lines.length) return "";
    return `What has been said in this conversation so far, oldest first. You do not have it in mind, so it is written out for you; the website's files are as the work so far left them.\n\n${lines.join("\n\n")}\n\nThat was the conversation so far. What the person says now:`;
}
