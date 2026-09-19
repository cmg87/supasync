import { join, dirname } from "node:path";
import { homedir, platform } from "node:os";
import { mkdir, writeFile, unlink, cp } from "node:fs/promises";
import { run, dataHome } from "./index.ts";
const xml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const quote = (s: string) =>
  `"${s.replace(/%/g, "%%").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
export function serviceDefinition(
  os: string,
  node: string,
  entry: string,
  home: string,
) {
  if ([node, entry, home].some((s) => s.includes("\n") || s.includes("\r")))
    throw new Error("Invalid service path");
  if (os === "linux")
    return `[Unit]\nDescription=SupaSync encrypted vault sync\nAfter=network-online.target\n[Service]\nExecStart=${quote(node)} ${quote(entry)} daemon run\nEnvironment=${quote(`SUPASYNC_HOME=${home}`)}\nRestart=on-failure\nRestartSec=10\nUMask=0077\n[Install]\nWantedBy=default.target\n`;
  if (os === "darwin")
    return `<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>dev.supasync.daemon</string><key>ProgramArguments</key><array>${[node, entry, "daemon", "run"].map((s) => `<string>${xml(s)}</string>`).join("")}</array><key>EnvironmentVariables</key><dict><key>SUPASYNC_HOME</key><string>${xml(home)}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>`;
  if (os === "win32")
    return `<?xml version="1.0"?><Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers><Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings><Actions Context="Author"><Exec><Command>${xml(node)}</Command><Arguments>${xml(`"${entry}" daemon run --home "${home}"`)}</Arguments></Exec></Actions></Task>`;
  throw new Error("Service installation is unsupported on this OS");
}
export async function service(action: string, entry: string) {
  if (
    ![
      "install",
      "start",
      "stop",
      "restart",
      "status",
      "logs",
      "uninstall",
    ].includes(action)
  )
    throw new Error("Unknown service action");
  const os = platform();
  const path =
    os === "linux"
      ? join(homedir(), ".config", "systemd", "user", "supasync.service")
      : os === "darwin"
        ? join(
            homedir(),
            "Library",
            "LaunchAgents",
            "dev.supasync.daemon.plist",
          )
        : join(dataHome(), "supasync-task.xml");
  if (action === "install") {
    const runtime = join(dataHome(), "runtime");
    await mkdir(runtime, { recursive: true, mode: 0o700 });
    await cp(dirname(entry), runtime, { recursive: true });
    entry = join(runtime, "cli.js");
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(
      path,
      serviceDefinition(os, process.execPath, entry, dataHome()),
      { mode: 0o600 },
    );
    if (os === "linux") {
      await run("systemctl", ["--user", "daemon-reload"]);
      await run("systemctl", ["--user", "enable", "--now", "supasync.service"]);
    } else if (os === "darwin")
      await run("launchctl", ["bootstrap", `gui/${process.getuid!()}`, path]);
    else {
      await run("schtasks", ["/Create", "/TN", "SupaSync", "/XML", path, "/F"]);
      await run("schtasks", ["/Run", "/TN", "SupaSync"]);
    }
    return path;
  }
  if (action === "uninstall") {
    if (os === "linux") {
      await run("systemctl", [
        "--user",
        "disable",
        "--now",
        "supasync.service",
      ]);
      await unlink(path);
      await run("systemctl", ["--user", "daemon-reload"]);
    } else if (os === "darwin") {
      await run("launchctl", [
        "bootout",
        `gui/${process.getuid!()}/dev.supasync.daemon`,
      ]);
      await unlink(path);
    } else {
      await run("schtasks", ["/Delete", "/TN", "SupaSync", "/F"]);
      await unlink(path);
    }
    return "Service removed; local state and keys retained";
  }
  if (os === "linux")
    return action === "logs"
      ? run("journalctl", [
          "--user",
          "-u",
          "supasync.service",
          "-n",
          "100",
          "--no-pager",
        ])
      : run("systemctl", [
          "--user",
          action === "uninstall" ? "disable" : action,
          ...(action === "uninstall" ? ["--now"] : []),
          "supasync.service",
        ]);
  if (os === "darwin") {
    if (action === "logs")
      throw new Error("Inspect this user launch agent in macOS Console");
    const target = `gui/${process.getuid!()}/dev.supasync.daemon`;
    return run(
      "launchctl",
      action === "status"
        ? ["print", target]
        : action === "stop"
          ? ["bootout", target]
          : action === "start"
            ? ["bootstrap", `gui/${process.getuid!()}`, path]
            : ["kickstart", "-k", target],
    );
  }
  if (action === "logs")
    throw new Error("Inspect SupaSync task history in Windows Task Scheduler");
  if (action === "restart") await run("schtasks", ["/End", "/TN", "SupaSync"]);
  return run("schtasks", [
    action === "status" ? "/Query" : action === "stop" ? "/End" : "/Run",
    "/TN",
    "SupaSync",
  ]);
}
