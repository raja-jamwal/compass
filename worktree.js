const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");

/**
 * Check if a path is inside a git repository.
 * @param {string} cwd
 * @returns {{ isGit: boolean, repoRoot: string|null }}
 */
function detectGitRepo(cwd) {
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

/**
 * Generate a branch name from a thread timestamp.
 * @param {string} threadTs - e.g. "1707900000.123456"
 * @returns {string} - e.g. "slack/1707900000-123456"
 */
function branchNameFromThread(threadTs) {
  return `slack/${threadTs.replace(".", "-")}`;
}

/**
 * Create a worktree for a thread.
 * @param {string} repoRoot - path to the repo root
 * @param {string} threadTs - thread timestamp as worktree key
 * @param {string} baseBranch - branch to fork from (default: current HEAD)
 * @returns {{ worktreePath: string, branchName: string }}
 */
function createWorktree(repoRoot, threadTs, baseBranch) {
  const branchName = branchNameFromThread(threadTs);
  const treesDir = path.join(repoRoot, "trees");
  const wtPath = path.join(treesDir, branchName.replace(/\//g, "-"));

  if (!fs.existsSync(treesDir)) {
    fs.mkdirSync(treesDir, { recursive: true });
  }

  // Determine base branch if not specified
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

/**
 * Remove a worktree and its branch.
 * @param {string} repoRoot
 * @param {string} worktreePath
 * @param {string} branchName
 */
function removeWorktree(repoRoot, worktreePath, branchName) {
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

/**
 * Check if a worktree has uncommitted changes.
 * @param {string} worktreePath
 * @returns {boolean}
 */
function hasUncommittedChanges(worktreePath) {
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

/**
 * Copy .env files from source to target directory.
 * @param {string} sourceDir
 * @param {string} targetDir
 */
function copyEnvFiles(sourceDir, targetDir) {
  const envFiles = [".env", ".env.local", ".env.development"];
  for (const f of envFiles) {
    const src = path.join(sourceDir, f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(targetDir, f));
    }
  }
}

module.exports = {
  detectGitRepo,
  branchNameFromThread,
  createWorktree,
  removeWorktree,
  hasUncommittedChanges,
  copyEnvFiles,
};
