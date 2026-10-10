import { Component, type ErrorInfo, type ReactNode } from "react";

// The last line of defence: if a screen fails while drawing itself, the person
// sees what happened and a way to carry on, never an empty page. Their work is
// not on this screen (it is saved on the server), so reloading loses nothing.
export class Safety extends Component<{ children: ReactNode }, { failed: boolean }> {
    state = { failed: false };

    static getDerivedStateFromError(): { failed: boolean } {
        return { failed: true };
    }

    componentDidCatch(error: Error, info: ErrorInfo): void {
        console.error("A screen failed to draw:", error, info.componentStack);
    }

    render(): ReactNode {
        if (!this.state.failed) return this.props.children;
        return (
            <div className="boot safety" role="alert">
                <h1 className="display">
                    This screen <em>stopped working.</em>
                </h1>
                <p className="muted">
                    Nothing is lost: your website, its wording and anything your assistant is doing are saved and carry on. Reload to get
                    the screen back.
                </p>
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
