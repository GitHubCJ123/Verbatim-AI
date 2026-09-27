import { spawn } from "node:child_process";

export function spawnFile(command, args, options = {}) {
  return new Promise((resolve) => {
    const useGroup = process.platform !== "win32";
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      // Own process group so a timeout can kill the whole tree (e.g. a hung
      // `copilot` session that spawns its own children), not just the direct child.
      detached: useGroup,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timer = null;
    let killTimer = null;
    let timedOut = false;

    const killTree = (signal) => {
      try {
        if (useGroup && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        /* already exited */
      }
    };
    const finish = (result) => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve(result);
    };

    const timeoutMs = Number(options.timeoutMs) || 0;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree("SIGTERM");
        killTimer = setTimeout(() => killTree("SIGKILL"), 5000);
      }, timeoutMs);
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => finish({ code: 127, stdout, stderr: String(error) }));
    child.on("close", (code) =>
      finish({
        code: timedOut ? 124 : (code ?? 1),
        stdout,
        stderr: timedOut ? `${stderr}\n[timed out after ${timeoutMs}ms]` : stderr,
      }),
    );
  });
}

export function parseCommand(command) {
  const parts = [];
  let cur = "";
  let quote = null;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) {
        parts.push(cur);
        cur = "";
      }
    } else {
      cur += ch;
    }
  }
  if (cur) parts.push(cur);
  return parts;
}
