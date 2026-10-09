import { ArrowRight, ArrowUpRight, History, Lock, MousePointerClick, Stamp } from "lucide-react";
import type { PublicConfig } from "../lib/api";
import { signIn } from "../lib/api";
import type { Theme } from "../lib/hooks";
import { Dots, ThemeToggle, Wordmark } from "../ui/kit";

const AUTH_ERRORS: Record<string, string> = {
    denied: "Atelier is invite-only, and this account hasn't been invited yet.",
    expired: "That sign-in took too long. Please try again.",
    unverified: "Your identity provider didn't confirm your e-mail address.",
    failed: "Sign-in didn't work. Please try again.",
};

const STEPS = [
    {
        n: "01",
        title: "Describe it",
        body: "Say what you want in plain words: a page, a section, a change of tone. No templates to wrestle, no settings to learn.",
    },
    {
        n: "02",
        title: "Watch it take shape",
        body: "Your assistant builds in a private workspace while you watch the result on a desktop, tablet or phone frame.",
    },
    {
        n: "03",
        title: "Publish when it's right",
        body: "Nothing goes out until you press Publish. Every release is recorded, and any earlier one is a click away.",
    },
];

const RULES = [
    {
        icon: Stamp,
        title: "Only you can publish",
        body: "The assistant drafts. It has no way to release anything: publishing is a button, and the button is yours.",
    },
    {
        icon: History,
        title: "Every change can be undone",
        body: "Each request is saved as a version. Restore any of them, and the restore itself becomes a version you can undo.",
    },
    {
        icon: Lock,
        title: "A private room for every project",
        body: "Each site gets its own sealed workspace. The assistant in one room cannot see into another, or into the house keys.",
    },
    {
        icon: MousePointerClick,
        title: "No terminal, ever",
        body: "If you can describe it, you can build it. The machinery stays behind the wall where it belongs.",
    },
];

export function Landing({ config, theme, onToggleTheme }: { config: PublicConfig | null; theme: Theme; onToggleTheme: () => void }) {
    const authError = new URLSearchParams(window.location.search).get("auth_error");
    const canSignIn = config === null || config.authMode === "dev" || config.oidcConfigured;
    const enter = () => signIn("/");

    return (
        <div className="landing">
            <header className="landing-nav">
                <Wordmark />
                <nav>
                    <a href="#how" className="btn btn-ghost">
                        How it works
                    </a>
                    <a href="#rules" className="btn btn-ghost">
                        House rules
                    </a>
                    <ThemeToggle theme={theme} onToggle={onToggleTheme} />
                    <button type="button" className="btn btn-primary" onClick={enter} disabled={!canSignIn}>
                        Sign in
                    </button>
                </nav>
            </header>

            <section className="hero">
                <div className="hero-copy">
                    <p className="eyebrow reveal">A studio for websites</p>
                    <h1 className="display reveal" style={{ animationDelay: "60ms" }}>
                        Describe it.
                        <br />
                        See it.
                        <br />
                        <em>Publish it.</em>
                    </h1>
                    <p className="hero-lede reveal" style={{ animationDelay: "140ms" }}>
                        Atelier is a private studio where you say what your website should be and an AI assistant builds it in front of you.
                        You review every change, and nothing goes out until you say so.
                    </p>
                    {authError && (
                        <p className="hero-error reveal" role="alert">
                            {AUTH_ERRORS[authError] ?? AUTH_ERRORS.failed}
                            {authError === "denied" && config?.inviteHint ? ` ${config.inviteHint}` : ""}
                        </p>
                    )}
                    <div className="hero-actions reveal" style={{ animationDelay: "220ms" }}>
                        <button type="button" className="btn btn-seal btn-lg" onClick={enter} disabled={!canSignIn}>
                            Enter the studio <ArrowRight />
                        </button>
                        <span className="mono muted">
                            {canSignIn
                                ? `Invite-only · sign in with ${config?.providerName ?? "your account"}`
                                : "Sign-in is not configured yet"}
                        </span>
                    </div>
                </div>

                <Easel />
            </section>

            <section className="steps" id="how">
                <div className="section-head">
                    <p className="eyebrow">How it works</p>
                    <h2 className="display">
                        Three steps, <em>no homework.</em>
                    </h2>
                </div>
                <ol>
                    {STEPS.map((s) => (
                        <li key={s.n}>
                            <span className="step-n">{s.n}</span>
                            <h3>{s.title}</h3>
                            <p>{s.body}</p>
                        </li>
                    ))}
                </ol>
            </section>

            <section className="rules" id="rules">
                <div className="section-head">
                    <p className="eyebrow">House rules</p>
                    <h2 className="display">
                        Helpful by design.
                        <br />
                        <em>Careful by default.</em>
                    </h2>
                    <p className="section-lede">
                        An assistant that can build your website needs limits you can trust. These aren't settings. They're how the studio
                        is built.
                    </p>
                </div>
                <ul>
                    {RULES.map((r) => (
                        <li key={r.title}>
                            <r.icon />
                            <h3>{r.title}</h3>
                            <p>{r.body}</p>
                        </li>
                    ))}
                </ul>
            </section>

            <section className="closing">
                <h2 className="display">
                    The studio is <em>open.</em>
                </h2>
                <button type="button" className="btn btn-primary btn-lg" onClick={enter} disabled={!canSignIn}>
                    Start a website <ArrowUpRight />
                </button>
            </section>

            <footer className="landing-foot">
                <Wordmark />
                <span className="mono muted">Made by hand, with help.</span>
            </footer>
        </div>
    );
}

// The product, drawn in HTML: a conversation on the left, the site it produced on the right.
function Easel() {
    return (
        <div className="easel reveal" style={{ animationDelay: "200ms" }} aria-hidden="true">
            <div className="easel-chat">
                <div className="easel-bar">
                    <span className="wordmark">Atelier</span>
                    <span className="chip chip-live">Live</span>
                </div>
                <div className="bubble bubble-you">A site for my ceramics studio. Calm, lots of space, a shop link up top.</div>
                <div className="bubble bubble-them">
                    Done. I built a home page with a quiet hero, three featured pieces and a shop link in the header.
                </div>
                <div className="bubble bubble-you">Warmer. And make the headline bigger.</div>
                <div className="bubble bubble-them bubble-typing">
                    <Dots />
                </div>
                <div className="easel-composer">
                    <span>Describe a change…</span>
                    <i />
                </div>
            </div>
            <div className="easel-site">
                <div className="site-chrome">
                    <i />
                    <i />
                    <i />
                    <span>okoro-ceramics</span>
                </div>
                <div className="site-body">
                    <div className="site-nav">
                        <b>Okoro</b>
                        <span>Work</span>
                        <span>Studio</span>
                        <span className="site-shop">Shop</span>
                    </div>
                    <p className="site-kicker">Hand-thrown in Lagos</p>
                    <p className="site-title">
                        Vessels for
                        <br />
                        slow mornings.
                    </p>
                    <div className="site-grid">
                        <div className="pot pot-a" />
                        <div className="pot pot-b" />
                        <div className="pot pot-c" />
                    </div>
                </div>
            </div>
        </div>
    );
}
