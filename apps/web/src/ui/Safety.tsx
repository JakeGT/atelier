import { Component, type ErrorInfo, type ReactNode } from "react";
import { notice } from "../lib/watch";

// The last line of defence: if a screen fails while drawing itself, the person
// sees what happened and a way to carry on, never an empty page. Their work is
// not on this screen (it is saved on the server), so reloading loses nothing but
// what was being typed and had not been saved yet.
export class Safety extends Component<{ children: ReactNode }, { failed: boolean; told: boolean }> {
    state = { failed: false, told: false };

    // Going back (or forward) leaves the screen that failed: the one arrived at is given its chance.
    private readonly again = (): void => {
        if (this.state.failed) this.setState({ failed: false, told: false });
    };

    componentDidMount(): void {
        window.addEventListener("popstate", this.again);
    }

    componentWillUnmount(): void {
        window.removeEventListener("popstate", this.again);
    }

    static getDerivedStateFromError(): { failed: boolean } {
        return { failed: true };
    }

    componentDidCatch(error: Error, info: ErrorInfo): void {
        console.error("A screen failed to draw:", error, info.componentStack);
        // Whoever runs Atelier is told what failed and where, so it can be put right.
        const told = notice("crash", `${error.name}: ${error.message}`, `${error.stack ?? ""}\n${info.componentStack ?? ""}`);
        if (told) this.setState({ told });
    }

    render(): ReactNode {
        if (!this.state.failed) return this.props.children;
        return (
            <div className="boot safety" role="alert">
                <h1 className="display">
                    This screen <em>stopped working.</em>
                </h1>
                <p className="muted">
                    Your website, its saved wording and anything your assistant is doing are safe and carry on. Only something you were in
                    the middle of typing may need typing again. Reload to get the screen back.
                </p>
                {this.state.told && (
                    <p className="muted">We have been told about this: what went wrong and which page you were on, nothing you typed.</p>
                )}
                <div className="safety-actions">
                    <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
                        Reload this page
                    </button>
                    <button type="button" className="btn" onClick={() => window.location.assign("/studio")}>
                        Go to my websites
                    </button>
                </div>
            </div>
        );
    }
}
