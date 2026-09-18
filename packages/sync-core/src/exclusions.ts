import { DIAGNOSTIC_PREFIX } from "@supasync/protocol";

const OS_NOISE = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/i;

export function isExcluded(path: string, configDir = ".obsidian"): boolean {
  const cfg = configDir.replace(/\/+$/, "");
  if (path === cfg || path.startsWith(`${cfg}/`)) return true;
  if (path === ".git" || path.startsWith(".git/")) return true;
  if (path === ".trash" || path.startsWith(".trash/")) return true;
  if (path === DIAGNOSTIC_PREFIX || path.startsWith(`${DIAGNOSTIC_PREFIX}/`)) return true;
  if (path.includes("/.git/") || path.startsWith(".supasync/")) return true;
  if (OS_NOISE.test(path)) return true;
  return false;
}
