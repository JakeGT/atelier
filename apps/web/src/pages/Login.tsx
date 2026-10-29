import { ArrowLeft, ArrowRight } from "lucide-react";
import type { PublicConfig } from "../lib/api";
import { startSignIn } from "../lib/api";
import { navigate, type Theme } from "../lib/hooks";
import { ThemeToggle, Wordmark } from "../ui/kit";

const AUTH_ERRORS: Record<string, { title: string; body: string }> = {
    denied: {
        title: "This account isn't on the list yet.",
        body: "Atelier is invite-only for now.",
    },
    expired: {
        title: "That took a little too long.",
        body: "The sign-in window closed before it finished. Please try again.",
    },
    unverified: {
        title: "We couldn't confirm your e-mail.",
        body: "Your identity provider didn't vouch for that address. Try another account.",
    },
    failed: {
        title: "Sign-in didn't go through.",
        body: "Nothing was changed. Please try again.",
    },
};

// Only same-site paths are followed after signing in (the server checks this too).
export function safeNext(raw: string | null): string {
    if (!raw?.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/studio";
    // A browser drops tabs and line breaks from an address, so "/<tab>/elsewhere" would
    // become "//elsewhere". Ask it where the path really leads instead of guessing.
    try {
        return new URL(raw, window.location.origin).origin === window.location.origin ? raw : "/studio";
    } catch {
        return "/studio";
    }
}

export function Login({ config, theme, onToggleTheme }: { config: PublicConfig | null; theme: Theme; onToggleTheme: () => void }) {
    const params = new URLSearchParams(window.location.search);
    const next = safeNext(params.get("next"));
    const errorKey = params.get("auth_error");
    const error = errorKey ? (AUTH_ERRORS[errorKey] ?? AUTH_ERRORS.failed) : null;
    const ready = config !== null;
    const canSignIn = !ready || config.authMode === "dev" || config.oidcConfigured;
    const provider = config?.authMode === "dev" ? "the local developer account" : (config?.providerName ?? "your account");

    return (
        <div className="login">
            <header className="login-nav">
                <Wordmark />
                <ThemeToggle theme={theme} onToggle={onToggleTheme} />
            </header>

            <main className="login-main">
                <div className="login-card">
                    <p className="eyebrow">Sign in</p>
                    <h1 className="display">
                        Welcome to the <em>studio.</em>
                    </h1>
                    <p className="login-lede">Your websites, their history and your assistant are waiting where you left them.</p>

                    {error && (
                        <div className="login-error" role="alert">
                            <strong>{error.title}</strong>
                            <span>
                                {error.body}
                                {errorKey === "denied" && config?.inviteHint ? ` ${config.inviteHint}` : ""}
                            </span>
                        </div>
                    )}

                    <button type="button" className="btn btn-seal btn-lg login-go" onClick={() => startSignIn(next)} disabled={!canSignIn}>
                        Continue with {provider} <ArrowRight />
                    </button>

                    <p className="login-note mono muted">
                        {canSignIn
                            ? "Invite-only. We never see your password: sign-in happens with your identity provider."
                            : "Sign-in isn't configured on this server yet."}
                    </p>
                </div>

                <button type="button" className="btn btn-ghost login-back" onClick={() => navigate("/")}>
                    <ArrowLeft /> Back to the front page
                </button>
            </main>
        </div>
    );
}
