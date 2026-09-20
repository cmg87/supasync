export class DaemonClient {
  constructor(
    private endpoint: string,
    private token: string,
    private transport: typeof fetch = fetch,
  ) {
    const u = new URL(endpoint);
    if (
      u.protocol !== "http:" ||
      !["127.0.0.1", "[::1]", "localhost"].includes(u.hostname)
    )
      throw new Error("Daemon must use loopback");
  }
  async request<T>(path: string, payload?: unknown): Promise<T> {
    const response = await this.transport(`${this.endpoint}${path}`, {
      method: payload === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    if (!response.ok)
      throw new Error(
        `Daemon unavailable (${response.status}); delegated sync remains paused`,
      );
    return response.json() as Promise<T>;
  }
  status() {
    return this.request<{
      vaults: Array<{
        vaultId: string;
        busy: boolean;
        lastSync: string | null;
        error: string | null;
      }>;
    }>("/status");
  }
  release(vaultId: string) {
    return this.request("/release", { vaultId });
  }
  sync(vaultId: string) {
    return this.request("/sync", { vaultId });
  }
}
