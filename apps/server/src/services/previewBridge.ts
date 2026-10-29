import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The script added to pages shown in the editor's preview frame. It lives in
// apps/server/assets/preview-bridge.js (browser script, sent as text; see the
// comment there for what it does and why it has to exist).
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../assets/preview-bridge.js"), "utf8");

// Nothing in the script may end the element it is carried in, or open an HTML comment (after which
// the page's parser would no longer see where the script stops). The file holds neither today.
export const PREVIEW_BRIDGE = `<script>${source.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--")}</script>`;
