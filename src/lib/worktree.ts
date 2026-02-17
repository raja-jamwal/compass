import { execFileSync } from "child_process";
import path from "path";
import fs from "fs";
import type { GitInfo, WorktreeResult } from "../types.ts";

export function detectGitRepo(cwd: string): GitInfo {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return { isGit: true, repoRoot: root };
  } catch {
    return { isGit: false, repoRoot: null };
  }
}

export function branchNameFromThread(threadTs: string): string {
  return `slack/${threadTs.replace(".", "-")}`;
}

export function createWorktree(repoRoot: string, threadTs: string, baseBranch?: string): WorktreeResult {
  const branchName = branchNameFromThread(threadTs);
  const treesDir = path.join(repoRoot, "trees");
  const wtPath = path.join(treesDir, branchName.replace(/\//g, "-"));

  if (!fs.existsSync(treesDir)) {
    fs.mkdirSync(treesDir, { recursive: true });
  }

  if (!baseBranch) {
    try {
      baseBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: repoRoot,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    } catch {
      baseBranch = "main";
    }
  }

  execFileSync("git", ["worktree", "add", "-b", branchName, wtPath, baseBranch], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });

  try {
    execFileSync("git", ["worktree", "lock", wtPath, "--reason", `Slack thread: ${threadTs}`], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    // lock may fail if already locked, non-critical
  }

  return { worktreePath: wtPath, branchName };
}

export function removeWorktree(repoRoot: string, worktreePath: string, branchName: string): void {
  try {
    execFileSync("git", ["worktree", "unlock", worktreePath], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {}

  execFileSync("git", ["worktree", "remove", worktreePath, "--force"], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });

  try {
    execFileSync("git", ["branch", "-D", branchName], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {}
}

export function hasUncommittedChanges(worktreePath: string): boolean {
  try {
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: worktreePath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return status.trim().length > 0;
  } catch {
    return true; // assume dirty if we can't check
  }
}

export function copyEnvFiles(sourceDir: string, targetDir: string): void {
  const envFiles = [".env", ".env.local", ".env.development"];
  for (const f of envFiles) {
    const src = path.join(sourceDir, f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(targetDir, f));
    }
  }
}
