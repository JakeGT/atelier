import { ArrowRight, Check } from "lucide-react";
import type { FormEvent } from "react";
import { useState } from "react";
import type { Org, Session } from "../lib/api";
import { api, orgApi } from "../lib/api";
import { navigate, type Theme } from "../lib/hooks";
import { Dots, ThemeToggle, useToast, Wordmark } from "../ui/kit";
import { FIRST_PROMPT_KEY } from "./Studio";

interface Props {
    session: Session;
    orgs: Org[];
    onOrgsChanged: () => Promise<Org[]>;
    // The introduction is over (finished or skipped).
    onDone: () => void;
    theme: Theme;
    onToggleTheme: () => void;
}

const STEPS = ["Your studio", "Your assistant", "Your first website"] as const;

// The introduction someone sees the first time they arrive: their own studio is
// already there, so this names it, says how the assistant works, and gets a
// first website started. Every step can be skipped, and it is shown only once
// (it stays available at /welcome).
export function Welcome({ session, orgs, onOrgsChanged, onDone, theme, onToggleTheme }: Props) {
    const toast = useToast();
    const studio = orgs.find((o) => o.personalOf === session.id) ?? orgs[0];
    const firstName = session.name.trim().split(/[\s@]/)[0] || "there";
    const [step, setStep] = useState(0);
    const [studioName, setStudioName] = useState(studio?.name ?? "");
    const [siteName, setSiteName] = useState("");
    const [brief, setBrief] = useState("");
    const [busy, setBusy] = useState(false);

    if (!studio) return null;
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

    async function createSite(e: FormEvent) {
        e.preventDefault();
        if (!siteName.trim() || busy) return;
        setBusy(true);
        try {
            const project = await a.createProject(siteName.trim());
            if (brief.trim()) sessionStorage.setItem(FIRST_PROMPT_KEY, JSON.stringify({ projectId: project.id, prompt: brief.trim() }));
            await finish(`/o/${studio?.slug}/p/${project.slug}`);
        } catch (err) {
            toast((err as Error).message, "error");
            setBusy(false);
        }
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
                        <p className="eyebrow">Step 2 of 3</p>
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
                            Your assistant starts on a built-in AI model, so there is nothing to set up. If you have your own account with
                            an AI company such as Anthropic or OpenAI, you can connect it later under Studio settings, then Models.
                        </p>
                        <div className="welcome-actions">
                            <button type="button" className="btn" onClick={() => setStep(0)}>
                                Back
                            </button>
                            <button type="button" className="btn btn-seal btn-lg" onClick={() => setStep(2)}>
                                Continue <ArrowRight />
                            </button>
                        </div>
                    </div>
                )}

                {step === 2 && (
                    <form className="welcome-card" onSubmit={createSite}>
                        <p className="eyebrow">Step 3 of 3</p>
                        <h1 className="display">
                            Your first <em>website.</em>
                        </h1>
                        <label className="field-line">
                            <span className="eyebrow">What is it called?</span>
                            <input
                                value={siteName}
                                onChange={(e) => setSiteName(e.target.value)}
                                placeholder="Okoro Ceramics"
                                maxLength={120}
                            />
                            <span className="field-help">You can change the name later.</span>
                        </label>
                        <label className="field-line">
                            <span className="eyebrow">Describe it (if you like)</span>
                            <textarea
                                value={brief}
                                onChange={(e) => setBrief(e.target.value)}
                                rows={4}
                                placeholder="A one-page site for my ceramics studio: a big photo, a few pieces for sale, and how to find me."
                            />
                            <span className="field-help">
                                Your assistant starts building from this straight away. Leave it empty to start with a blank page.
                            </span>
                        </label>
                        <div className="welcome-actions">
                            <button type="button" className="btn" onClick={() => setStep(1)} disabled={busy}>
                                Back
                            </button>
                            <button type="submit" className="btn btn-seal btn-lg" disabled={!siteName.trim() || busy}>
                                {busy ? (
                                    <Dots />
                                ) : (
                                    <>
                                        Create my website <ArrowRight />
                                    </>
                                )}
                            </button>
                        </div>
                    </form>
                )}

                <p className="welcome-skip">
                    <button type="button" className="link" onClick={() => void finish(`/o/${studio.slug}`)} disabled={busy}>
                        {step === 2 ? "I'll make a website later: take me to my studio" : "Skip the introduction and go to my studio"}
                    </button>
                </p>
            </main>
        </div>
    );
}
