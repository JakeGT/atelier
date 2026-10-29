import { ArrowRight, Check } from "lucide-react";
import type { FormEvent } from "react";
import { useState } from "react";
import type { Org, Session } from "../lib/api";
import { api, orgApi } from "../lib/api";
import { navigate, type Theme } from "../lib/hooks";
import { Dots, ThemeToggle, useToast, Wordmark } from "../ui/kit";

interface Props {
    session: Session;
    orgs: Org[];
    onOrgsChanged: () => Promise<Org[]>;
    // The introduction is over (finished or skipped).
    onDone: () => void;
    theme: Theme;
    onToggleTheme: () => void;
}

const STEPS = ["Your studio", "Your assistant"] as const;

// The introduction someone sees the first time they arrive: their own studio is
// already there, so this names it and says how the assistant works, then takes
// them to their studio page, where a first website is one form away when they
// want one. It can be skipped, and is shown only once (it stays available at /welcome).
export function Welcome({ session, orgs, onOrgsChanged, onDone, theme, onToggleTheme }: Props) {
    const toast = useToast();
    const studio = orgs.find((o) => o.personalOf === session.id) ?? orgs[0];
    const firstName = session.name.trim().split(/[\s@]/)[0] || "there";
    const [step, setStep] = useState(0);
    const [studioName, setStudioName] = useState(studio?.name ?? "");
    const [busy, setBusy] = useState(false);

    // Their studios could not be fetched: say so and offer another go, rather than an empty page.
    async function retry() {
        if (busy) return;
        setBusy(true);
        const list = await onOrgsChanged();
        const found = list.find((o) => o.personalOf === session.id) ?? list[0];
        if (found) setStudioName(found.name);
        setBusy(false);
    }

    if (!studio) {
        return (
            <div className="welcome">
                <header className="login-nav">
                    <Wordmark />
                    <ThemeToggle theme={theme} onToggle={onToggleTheme} />
                </header>
                <main className="welcome-main">
                    <div className="welcome-card" role="alert">
                        <p className="eyebrow">Welcome to Atelier</p>
                        <p className="welcome-lede">Your studio could not be loaded. Nothing was changed.</p>
                        <div className="welcome-actions">
                            <button type="button" className="btn btn-seal btn-lg" onClick={() => void retry()} disabled={busy}>
                                {busy ? <Dots /> : "Try again"}
                            </button>
                        </div>
                    </div>
                </main>
            </div>
        );
    }
    const a = orgApi(studio.slug);

    // Marks the introduction done and goes on. A failure here must not trap someone in the introduction.
    async function finish(to: string) {
        await api.finishOnboarding().catch(() => {});
        onDone();
        navigate(to, { replace: true });
    }

    async function saveStudio(e: FormEvent) {
        e.preventDefault();
        const name = studioName.trim();
        if (!name || busy) return;
        if (name !== studio?.name) {
            setBusy(true);
            try {
                await a.update({ name });
                await onOrgsChanged();
            } catch (err) {
                toast((err as Error).message, "error");
                setBusy(false);
                return;
            }
            setBusy(false);
        }
        setStep(1);
    }

    return (
        <div className="welcome">
            <header className="login-nav">
                <Wordmark />
                <ThemeToggle theme={theme} onToggle={onToggleTheme} />
            </header>

            <main className="welcome-main">
                <ol className="welcome-steps" aria-label="Introduction steps">
                    {STEPS.map((label, i) => (
                        <li
                            key={label}
                            className={i === step ? "on" : i < step ? "done" : ""}
                            aria-current={i === step ? "step" : undefined}
                        >
                            <span className="welcome-step-mark">{i < step ? <Check /> : i + 1}</span>
                            {label}
                        </li>
                    ))}
                </ol>

                {step === 0 && (
                    <form className="welcome-card" onSubmit={saveStudio}>
                        <p className="eyebrow">Welcome to Atelier</p>
                        <h1 className="display">
                            Hello, <em>{firstName}.</em>
                        </h1>
                        <p className="welcome-lede">
                            Atelier is a studio where you describe a website and your assistant builds it in front of you. Nothing goes
                            public until you press Publish.
                        </p>
                        <label className="field-line">
                            <span className="eyebrow">The name of your studio</span>
                            <input value={studioName} onChange={(e) => setStudioName(e.target.value)} maxLength={80} />
                            <span className="field-help">
                                A studio holds your websites. This one is yours alone. Later you can make more studios to share with a team
                                or a client.
                            </span>
                        </label>
                        <div className="welcome-actions">
                            <button type="submit" className="btn btn-seal btn-lg" disabled={!studioName.trim() || busy}>
                                {busy ? (
                                    <Dots />
                                ) : (
                                    <>
                                        Continue <ArrowRight />
                                    </>
                                )}
                            </button>
                        </div>
                    </form>
                )}

                {step === 1 && (
                    <div className="welcome-card">
                        <p className="eyebrow">Step 2 of 2</p>
                        <h1 className="display">
                            How your <em>assistant</em> works.
                        </h1>
                        <ol className="welcome-how">
                            <li>
                                <strong>Describe it.</strong> Say what you want in your own words: "a home page for my café, with opening
                                hours and a menu".
                            </li>
                            <li>
                                <strong>See it.</strong> Your assistant builds it while you watch. Ask for changes as often as you like;
                                every change is saved, so you can always go back.
                            </li>
                            <li>
                                <strong>Publish it.</strong> When you are happy, press Publish and it goes live at its own address. You can
                                take it offline again at any time.
                            </li>
                        </ol>
                        <p className="welcome-note">
                            Next is your studio page, where you name a website and describe it whenever you are ready. Your assistant starts
                            on a built-in AI model, so there is nothing to set up. If you have your own account with an AI company such as
                            Anthropic or OpenAI, you can connect it later under Studio settings, then Models.
                        </p>
                        <div className="welcome-actions">
                            <button type="button" className="btn" onClick={() => setStep(0)}>
                                Back
                            </button>
                            <button type="button" className="btn btn-seal btn-lg" onClick={() => void finish(`/o/${studio.slug}`)}>
                                Go to my studio <ArrowRight />
                            </button>
                        </div>
                    </div>
                )}

                <p className="welcome-skip">
                    <button type="button" className="link" onClick={() => void finish(`/o/${studio.slug}`)} disabled={busy}>
                        Skip the introduction and go to my studio
                    </button>
                </p>
            </main>
        </div>
    );
}
