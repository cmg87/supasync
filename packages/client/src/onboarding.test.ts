import { describe, expect, it } from "vitest";
import { decideVaultSelection, type VaultInfo } from "./index.ts";

function vault(id: string, name: string): VaultInfo {
  return {
    id,
    name,
    role: "owner",
    protocolVersion: 1,
    serverEpoch: "epoch",
    headSeq: "0",
    namespaceSeq: "0",
    replayFloor: "0",
    defaultStorageBackendId: null,
    retentionDays: 30,
    minVersionsPerEntry: 20,
    maxBlobBytes: 1,
    maxTextBytes: 1,
  };
}

describe("vault onboarding decisions", () => {
  it("creates a vault named after the local vault for a fresh user", () => {
    expect(decideVaultSelection([], "", "My Notes")).toEqual({ type: "create", name: "My Notes" });
    expect(decideVaultSelection([], "stale-from-another-account", "My Notes")).toEqual({
      type: "create",
      name: "My Notes",
    });
  });

  it("selects the only vault automatically", () => {
    const only = vault("v1", "Notes");
    expect(decideVaultSelection([only], "", "Other")).toEqual({ type: "select", vault: only });
  });

  it("keeps a stored vault when it is still accessible", () => {
    const a = vault("a", "A");
    const b = vault("b", "B");
    expect(decideVaultSelection([a, b], "b", "Local")).toEqual({ type: "select", vault: b });
  });

  it("does not guess when multiple vaults exist and the stored id is missing", () => {
    const a = vault("a", "A");
    const b = vault("b", "B");
    expect(decideVaultSelection([a, b], "gone", "Local")).toEqual({ type: "prompt", vaults: [a, b] });
    expect(decideVaultSelection([a, b], "", "Local")).toEqual({ type: "prompt", vaults: [a, b] });
  });
});
