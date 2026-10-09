/**
 * Where prifly's host runs, and so where this extension finds what it reads.
 *
 * - Inside WSL (or plain Linux): Linux is this kernel's own `/proc`, and
 *   Windows' tools, where there is a Windows around it, are at `/mnt/c`.
 * - On Windows itself: Windows' tools are in `%SystemRoot%\System32`, and the
 *   WSL VM's Linux is read through one `wsl.exe` (`wsl-exe.ts`), never through
 *   `\\wsl.localhost` or a `/proc` of its own. The process table and Docker's
 *   containers are not read there.
 */

export type Host = {
  /** True when the host runs on Windows itself, not inside WSL. */
  native: boolean;
  typeperf: string;
  powershell: string;
  /** `wsl.exe`, which only a host on Windows starts. */
  wsl: string;
  /** A Windows folder for the tools to start in. */
  system32: string;
};

/** The host for a platform and environment; `process.platform` and `process.env` in the extension. */
export function hostOf(platform: string, env: Record<string, string | undefined>): Host {
  if (platform === "win32") {
    const root = (env["SystemRoot"] ?? env["SYSTEMROOT"] ?? "C:\\Windows").replace(/\\+$/, "");
    const system32 = `${root}\\System32`;
    return {
      native: true,
      typeperf: `${system32}\\typeperf.exe`,
      powershell: `${system32}\\WindowsPowerShell\\v1.0\\powershell.exe`,
      wsl: `${system32}\\wsl.exe`,
      system32,
    };
  }
  const system32 = "/mnt/c/Windows/System32";
  return {
    native: false,
    typeperf: `${system32}/typeperf.exe`,
    powershell: `${system32}/WindowsPowerShell/v1.0/powershell.exe`,
    wsl: `${system32}/wsl.exe`,
    system32,
  };
}

/** This host. */
export const HOST: Host = hostOf(process.platform, process.env);
