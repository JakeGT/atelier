import { ArrowRight, ArrowUpRight, History, Lock, MousePointerClick, Stamp } from "lucide-react";
import { useEffect, useRef } from "react";
import type { PublicConfig, Session } from "../lib/api";
import { navigate, type Theme } from "../lib/hooks";
import { Dots, ThemeToggle, UserMenu, Wordmark } from "../ui/kit";

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

interface LandingProps {
    // null when signed out, undefined while that is still being worked out. The
    // page is the same either way; only the way in changes.
    session: Session | null | undefined;
    config: PublicConfig | null;
    theme: Theme;
    onToggleTheme: () => void;
}

export function Landing({ session, config, theme, onToggleTheme }: LandingProps) {
    // Until we know, head for the studio: it sends signed-out visitors to the login page.
    const enter = () => navigate(session === null ? "/login" : "/studio");

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
                    {!session && <ThemeToggle theme={theme} onToggle={onToggleTheme} />}
                    {session ? (
                        <>
                            <button type="button" className="btn btn-primary" onClick={enter}>
                                Open studio <ArrowRight />
                            </button>
                            <UserMenu session={session} theme={theme} onToggleTheme={onToggleTheme} />
                        </>
                    ) : session === null ? (
                        <button type="button" className="btn btn-primary" onClick={enter}>
                            Sign in
                        </button>
                    ) : null}
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
                    <div className="hero-actions reveal" style={{ animationDelay: "220ms" }}>
                        <button type="button" className="btn btn-seal btn-lg" onClick={enter}>
                            {session ? "Open your studio" : "Enter the studio"} <ArrowRight />
                        </button>
                        <span className="mono muted">
                            {session
                                ? `Signed in as ${session.email}`
                                : `Invite-only · sign in with ${config?.providerName ?? "your account"}`}
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
                <button type="button" className="btn btn-primary btn-lg" onClick={enter}>
                    {session ? "Back to your websites" : "Start a website"} <ArrowUpRight />
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
// Where the easel sits when nobody is pointing at it, and how far it may turn.
const REST = { rx: 3, ry: -9, rz: 1 };
const REACH = { rx: 5, ry: 7 };

// Turns the easel a few degrees toward the pointer, easing every frame, and lets
// it settle back to its resting angle when the pointer leaves. Skipped on touch
// devices and for anyone who has asked their system for less motion.
function useTilt() {
    const stage = useRef<HTMLDivElement>(null);
    const card = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const s = stage.current;
        const c = card.current;
        if (!s || !c) return;
        const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
        const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        if (!finePointer || calm) return;

        let target = { ...REST };
        const now = { ...REST };
        let frame = 0;

        const step = () => {
            let settled = true;
            for (const k of ["rx", "ry", "rz"] as const) {
                const gap = target[k] - now[k];
                if (Math.abs(gap) > 0.01) settled = false;
                now[k] += gap * 0.075;
                c.style.setProperty(`--${k}`, `${now[k].toFixed(3)}deg`);
            }
            frame = settled ? 0 : requestAnimationFrame(step);
        };
        const wake = () => {
            if (!frame) frame = requestAnimationFrame(step);
        };
        const onMove = (e: PointerEvent) => {
            const r = s.getBoundingClientRect();
            const x = ((e.clientX - r.left) / r.width) * 2 - 1;
            const y = ((e.clientY - r.top) / r.height) * 2 - 1;
            // Lean toward the pointer: the near edge dips, like a board on a pivot.
            target = { rx: -y * REACH.rx, ry: x * REACH.ry, rz: 0 };
            wake();
        };
        const onLeave = () => {
            target = { ...REST };
            wake();
        };

        s.addEventListener("pointermove", onMove);
        s.addEventListener("pointerleave", onLeave);
        return () => {
            s.removeEventListener("pointermove", onMove);
            s.removeEventListener("pointerleave", onLeave);
            cancelAnimationFrame(frame);
        };
    }, []);

    return { stage, card };
}

function Easel() {
    const { stage, card } = useTilt();
    return (
        // The stage carries the entrance animation and the perspective; the easel
        // inside it carries the tilt. (One element doing both made the tilt snap:
        // a finished animation keeps hold of `transform`.)
        <div className="easel-stage reveal" style={{ animationDelay: "200ms" }} ref={stage} aria-hidden="true">
            <div className="easel" ref={card}>
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
        </div>
    );
}
