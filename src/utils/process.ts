import { spawn } from "node:child_process";

const MAX_OUTPUT_CHARS = 256 * 1024;

export interface ProcessResult {
  code: number | null;
  output: string;
  timedOut: boolean;
  error?: Error;
}

export interface RunOptions {
  cwd?: string;
  /** Variables added to the server environment. */
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Called when the timeout kills the process, e.g. to stop a container. */
  onTimeout?: () => void;
}

/** Runs a command without a shell and keeps the tail of stdout and stderr. */
export function runProcess(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    const append = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-MAX_OUTPUT_CHARS);
    };

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : undefined,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            options.onTimeout?.();
            child.kill("SIGKILL");
          }, options.timeoutMs);

    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, output, timedOut, error });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut });
    });
  });
}

/** The last `count` non-blank lines of `output`. */
export function lastLines(output: string, count: number): string {
  return output
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .slice(-count)
    .join("\n");
}
