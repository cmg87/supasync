import { canonicalizePath } from "@supasync/protocol";

export function conflictCopyPath(originalPath: string, clientLabel: string, operationId: string): string {
  const canon = canonicalizePath(originalPath);
  const slash = canon.display.lastIndexOf("/");
  const dir = slash === -1 ? "" : canon.display.slice(0, slash + 1);
  const name = slash === -1 ? canon.display : canon.display.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const stem = dot === -1 ? name : name.slice(0, dot);
  const ext = dot === -1 ? "" : name.slice(dot);
  const label = sanitizeLabel(clientLabel);
  const suffix = operationId.replaceAll("-", "").slice(0, 6);
  return `${dir}${stem} (conflict ${label} ${suffix})${ext}`;
}

function sanitizeLabel(label: string): string {
  const cleaned = label.replace(/[\\/:*?"<>|]/g, "").trim() || "device";
  return cleaned.slice(0, 24);
}
