import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface Checkpoint {
    sha: string;
    message: string;
    date: string;
}

export const SHA_RE = /^[0-9a-f]{40}$/;

const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
};

export const mimeFor = (path: string): string => MIME[extname(path).toLowerCase()] ?? "application/octet-stream";

// Git is run with hooks and repo-configured helpers neutralized: the repository
// is written by the agent, so its .git/config must not be able to make git run
// a program (fsmonitor, hooks, pagers, credential helpers).
const SAFE_GIT = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.pager=cat", "-c", "credential.helper="];

async function git(dir: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", [...SAFE_GIT, ...args], {
        cwd: dir,
        env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    });
    return String(stdout).trim();
}

// One project's working tree, backed by git for checkpoint / undo / redo. Used
// inside the runtime container (runtime/daemon.ts) and, for local development
// only, in-process by LocalRuntime.
export class Workspace {
    readonly dir: string;

    constructor(dir: string) {
        this.dir = dir;
    }

    async init(): Promise<void> {
        await mkdir(this.dir, { recursive: true });
        const isRepo = await git(this.dir, ["rev-parse", "--is-inside-work-tree"]).then(
            () => true,
            () => false,
        );
        if (!isRepo) {
            await git(this.dir, ["init", "-q", "-b", "main"]);
            await git(this.dir, ["config", "user.email", "agent@atelier.invalid"]);
            await git(this.dir, ["config", "user.name", "Atelier"]);
        }
    }

    async checkpoint(message: string): Promise<string | null> {
        await git(this.dir, ["add", "-A"]);
        const status = await git(this.dir, ["status", "--porcelain"]);
        if (!status) return null;
        await git(this.dir, ["commit", "-q", "--no-verify", "-m", message || "Saved version"]);
        return git(this.dir, ["rev-parse", "HEAD"]);
    }

    async listCheckpoints(): Promise<Checkpoint[]> {
        const log = await git(this.dir, ["log", "-n", "200", "--format=%H%x00%s%x00%cI"]).catch(() => "");
        if (!log) return [];
        return log.split("\n").map((line) => {
            const [sha, message, date] = line.split("\0");
            return { sha: sha ?? "", message: message ?? "", date: date ?? "" };
        });
    }

    // Restoring a version records a new commit with that version's tree, so the
    // timeline only grows and every restore can itself be undone.
    async restore(sha: string): Promise<string | null> {
        if (!SHA_RE.test(sha)) throw new Error("invalid commit sha");
        await git(this.dir, ["cat-file", "-e", `${sha}^{commit}`]);
        await git(this.dir, ["read-tree", "-u", "--reset", sha]);
        await git(this.dir, ["clean", "-fdq"]);
        return this.checkpoint(`Restored version ${sha.slice(0, 7)}`);
    }

    // Puts a starter template's files in place, as the website's first version.
    // Only into an empty website: it never overwrites someone's work.
    async seed(files: { path: string; content: string }[], message: string): Promise<string | null> {
        await this.init();
        if (await this.head()) return null;
        const base = resolve(this.dir);
        for (const f of files) {
            const target = resolve(join(base, f.path));
            const parts = f.path.split("/");
            if (!target.startsWith(`${base}/`) || parts.some((p) => p === ".." || p.startsWith(".") || p === "")) {
                throw new Error(`invalid template path: ${f.path}`);
            }
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, Buffer.from(f.content, "base64"));
        }
        return this.checkpoint(message);
    }

    // The files of one saved version, as a tar archive: what publishing ships.
    // Only what git has recorded, so nothing untracked and never .git itself.
    async archive(sha: string): Promise<Buffer> {
        if (!SHA_RE.test(sha)) throw new Error("invalid commit sha");
        const { stdout } = await execFileAsync("git", [...SAFE_GIT, "archive", "--format=tar", sha], {
            cwd: this.dir,
            env: {
                PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
                HOME: this.dir,
                GIT_CONFIG_NOSYSTEM: "1",
                GIT_TERMINAL_PROMPT: "0",
            },
            encoding: "buffer",
            maxBuffer: 512 * 1024 * 1024,
        });
        return stdout;
    }

    async head(): Promise<string | null> {
        return git(this.dir, ["rev-parse", "HEAD"]).catch(() => null);
    }

    // Reads a file inside the workspace, refusing anything that resolves (after
    // symlinks) outside it, and anything under .git.
    async readFile(rel: string): Promise<{ body: Uint8Array; contentType: string } | null> {
        const base = await realpath(resolve(this.dir));
        const target = resolve(join(base, rel || "index.html"));
        if (target !== base && !target.startsWith(`${base}/`)) return null;
        if (target === join(base, ".git") || target.startsWith(`${join(base, ".git")}/`)) return null;
        try {
            const real = await realpath(target);
            if (!real.startsWith(`${base}/`)) return null;
            return { body: await readFile(real), contentType: mimeFor(real) };
        } catch {
            return null;
        }
    }
}
