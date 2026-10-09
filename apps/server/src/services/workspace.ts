import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface Checkpoint {
    sha: string;
    message: string;
    date: string;
}

async function git(dir: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, { cwd: dir });
    return String(stdout).trim();
}

// A per-project workspace on the local filesystem, backed by git for
// checkpoint / undo / redo. This is the P1 "sandbox" (a directory, mirroring the
// single-container editor we are replacing); real isolation (gVisor/microVM) is a
// P5 hardening item (ADR-0003).
export class WorkspaceService {
    readonly root: string;
    readonly mcpEntry: string;

    constructor(root: string, mcpEntry: string) {
        this.root = root;
        this.mcpEntry = mcpEntry;
    }

    dir(projectId: string): string {
        return join(this.root, projectId);
    }

    async provision(projectId: string, mcpEnv: Record<string, string>): Promise<string> {
        const dir = this.dir(projectId);
        await mkdir(dir, { recursive: true });
        const isRepo = await git(dir, ["rev-parse", "--is-inside-work-tree"]).then(
            () => true,
            () => false,
        );
        if (!isRepo) {
            await git(dir, ["init", "-q"]);
            await git(dir, ["config", "user.email", "atelier@localhost"]);
            await git(dir, ["config", "user.name", "Atelier Agent"]);
        }
        await writeFile(
            join(dir, "opencode.json"),
            JSON.stringify(
                {
                    mcp: {
                        "atelier-content": {
                            type: "local",
                            command: ["node", this.mcpEntry],
                            environment: mcpEnv,
                        },
                    },
                },
                null,
                2,
            ),
        );
        return dir;
    }

    async checkpoint(projectId: string, message: string): Promise<string | null> {
        const dir = this.dir(projectId);
        await git(dir, ["add", "-A"]);
        const status = await git(dir, ["status", "--porcelain"]);
        if (!status) return null;
        await git(dir, ["commit", "-q", "-m", message]);
        return git(dir, ["rev-parse", "HEAD"]);
    }

    async listCheckpoints(projectId: string): Promise<Checkpoint[]> {
        const dir = this.dir(projectId);
        const log = await git(dir, ["log", "--format=%H%x00%s%x00%cI"]).catch(() => "");
        if (!log) return [];
        return log.split("\n").map((line) => {
            const [sha, message, date] = line.split("\0");
            return { sha: sha ?? "", message: message ?? "", date: date ?? "" };
        });
    }

    async reset(projectId: string, ref: string): Promise<void> {
        const dir = this.dir(projectId);
        await git(dir, ["reset", "--hard", ref]);
        await git(dir, ["clean", "-fd"]);
    }

    async head(projectId: string): Promise<string | null> {
        const dir = this.dir(projectId);
        return git(dir, ["rev-parse", "HEAD"]).catch(() => null);
    }
}
