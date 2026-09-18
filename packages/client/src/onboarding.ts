import type { VaultInfo } from "@supasync/protocol";

export type VaultDecision =
  | { type: "create"; name: string }
  | { type: "select"; vault: VaultInfo }
  | { type: "prompt"; vaults: VaultInfo[] };

export function decideVaultSelection(
  vaults: VaultInfo[],
  storedVaultId: string | undefined,
  localVaultName: string,
): VaultDecision {
  const stored = storedVaultId?.trim() ?? "";
  if (stored) {
    const match = vaults.find((vault) => vault.id === stored);
    if (match) {
      return { type: "select", vault: match };
    }
  }
  if (vaults.length === 0) {
    return { type: "create", name: localVaultName.trim() || "Vault" };
  }
  if (vaults.length === 1) {
    return { type: "select", vault: vaults[0]! };
  }
  return { type: "prompt", vaults };
}

export function vaultAccessible(vaults: VaultInfo[], vaultId: string | undefined): boolean {
  const id = vaultId?.trim() ?? "";
  return Boolean(id) && vaults.some((vault) => vault.id === id);
}
