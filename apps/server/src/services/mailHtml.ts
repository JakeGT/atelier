// Atelier's e-mails, drawn like Atelier itself: warm paper, ink, the red seal, a serif
// headline, and the logo at the top. Mail programs understand far less than browsers,
// so this is tables and inline styles; the colours are the app's own (tokens.css), with
// the app's dark colours for programs that ask for them. A plain-text copy always goes too.

const LIGHT = { paper: "#f5f1e8", surface: "#fbf9f4", ink: "#17150f", ink2: "#4b473d", ink3: "#8b8576", line: "#e3ddcf", seal: "#dc4326" };
const DARK = { paper: "#100f0c", surface: "#181713", ink: "#f3efe4", ink2: "#bfb9aa", ink3: "#7f7a6c", line: "#2a2822", seal: "#ff6b4a" };
// Mail programs cannot load the app's fonts; these are the nearest that devices have.
const SERIF = `'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, 'Times New Roman', serif`;
const SANS = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`;

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Plain words as paragraphs; an address written out becomes a link.
function paragraphs(text: string): string {
    return text
        .trim()
        .split(/\n{2,}/)
        .map((block) => {
            const lines = esc(block.trim())
                .replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, `<a href="$1" class="a-link" style="color:${LIGHT.seal};">$1</a>`)
                .replace(/\n/g, "<br>");
            return `<p class="a-text" style="margin:0 0 14px;font:16px/1.6 ${SANS};color:${LIGHT.ink2};">${lines}</p>`;
        })
        .join("\n");
}

export interface MailParts {
    // The headline: what this is about.
    title: string;
    body: string;
    // Where to go and look, as a button.
    action?: { href: string; label: string } | null;
    // A quiet last line (how to stop these, who sent it).
    foot?: string;
    // Where Atelier is, for the logo and the link on it.
    origin: string;
}

export function mailHtml({ title, body, action, foot, origin }: MailParts): string {
    const button = action
        ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:10px 0 6px;"><tr><td class="a-button" style="background:${LIGHT.ink};border-radius:999px;">
<a href="${esc(action.href)}" class="a-button-text" style="display:inline-block;padding:12px 22px;font:500 15px/1 ${SANS};color:${LIGHT.paper};text-decoration:none;">${esc(action.label)}</a>
</td></tr></table>`
        : "";
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(title)}</title>
<style>
@media (prefers-color-scheme: dark) {
  .a-page { background: ${DARK.paper} !important; }
  .a-card { background: ${DARK.surface} !important; border-color: ${DARK.line} !important; }
  .a-mark, .a-title { color: ${DARK.ink} !important; }
  .a-text { color: ${DARK.ink2} !important; }
  .a-foot { color: ${DARK.ink3} !important; border-color: ${DARK.line} !important; }
  .a-link, .a-dot { color: ${DARK.seal} !important; }
  .a-logo { box-shadow: 0 0 0 1px ${DARK.line}; }
  .a-button { background: ${DARK.ink} !important; }
  .a-button-text { color: ${DARK.paper} !important; }
}
@media (max-width: 520px) { .a-card { padding: 26px 22px !important; } .a-title { font-size: 27px !important; } }
</style>
</head>
<body class="a-page" style="margin:0;padding:0;background:${LIGHT.paper};">
<table role="presentation" class="a-page" width="100%" cellpadding="0" cellspacing="0" style="background:${LIGHT.paper};">
<tr><td align="center" style="padding:36px 16px 44px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
<tr><td style="padding:0 6px 20px;">
<a href="${esc(origin)}" style="text-decoration:none;">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="padding-right:11px;"><img src="${esc(origin)}/mail-logo.png" width="36" height="36" alt="" class="a-logo" style="display:block;border:0;border-radius:8px;"></td>
<td class="a-mark" style="font:italic 26px/1 ${SERIF};letter-spacing:-0.02em;color:${LIGHT.ink};">Atelier<span class="a-dot" style="color:${LIGHT.seal};">.</span></td>
</tr></table>
</a>
</td></tr>
<tr><td class="a-card" style="background:${LIGHT.surface};border:1px solid ${LIGHT.line};border-radius:16px;padding:34px 36px 30px;">
<h1 class="a-title" style="margin:0 0 16px;font:400 31px/1.15 ${SERIF};letter-spacing:-0.015em;color:${LIGHT.ink};">${esc(title)}</h1>
${paragraphs(body)}
${button}
</td></tr>
${foot ? `<tr><td class="a-foot" style="padding:18px 6px 0;font:13px/1.55 ${SANS};color:${LIGHT.ink3};">${esc(foot)}</td></tr>` : ""}
</table>
</td></tr>
</table>
</body>
</html>
`;
}
