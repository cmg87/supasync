import { backendKeyFromUrl } from "@supasync/client";
import { digestCanonical, PLUGIN_ID } from "@supasync/protocol";

export function syncStoreId(input: {
  installationId: string;
  backendUrl: string;
  vaultId: string;
}): string {
  const backend = backendKeyFromUrl(input.backendUrl);
  return `${PLUGIN_ID}-v3-${input.installationId}-${backend}-${input.vaultId}`;
}

export function newInstallationId(): string {
  return crypto.randomUUID();
}

/** Obsidian SecretStorage accepts only lowercase letters, digits and dashes, up to 64 characters. */
export async function installationSessionSecretId(
  backendUrl: string,
  installationId: string,
): Promise<string> {
  const backend = new URL(backendUrl).href.replace(/\/$/, "");
  const digest = await digestCanonical([backend, installationId]);
  // Keep 220 bits of the digest; do not truncate the backend or installation inputs.
  return `supasync-${digest.slice(0, 55)}`;
}
