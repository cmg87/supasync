import { backendKeyFromUrl } from "@supasync/client";
import { PLUGIN_ID } from "@supasync/protocol";

export function syncStoreId(input: {
  installationId: string;
  backendUrl: string;
  vaultId: string;
}): string {
  const backend = backendKeyFromUrl(input.backendUrl);
  return `${PLUGIN_ID}-${input.installationId}-${backend}-${input.vaultId}`;
}

export function newInstallationId(): string {
  return crypto.randomUUID();
}
