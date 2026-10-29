import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { startWatching } from "./lib/watch";
import { Safety } from "./ui/Safety";
import "@fontsource/instrument-serif/400.css";
import "@fontsource/instrument-serif/400-italic.css";
import "@fontsource-variable/geist/wght.css";
import "@fontsource-variable/geist-mono/wght.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/landing.css";
import "./styles/studio.css";
import "./styles/editor.css";

startWatching();

const root = document.getElementById("root");
if (!root) throw new Error("root element not found");

createRoot(root).render(
    <StrictMode>
        <Safety>
            <App />
        </Safety>
    </StrictMode>,
);
