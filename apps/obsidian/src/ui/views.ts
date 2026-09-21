import { ItemView, WorkspaceLeaf } from "obsidian";

export const HISTORY_VIEW = "supasync-history";

export type HistoryItem = {
  seq: string;
  path: string;
  serverTime: string;
  tombstone: boolean;
};
export class HistoryView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private readonly read: () => Promise<HistoryItem[]>,
    private readonly restore: (seq: string) => Promise<void>,
  ) {
    super(leaf);
  }
  getViewType() {
    return HISTORY_VIEW;
  }
  getDisplayText() {
    return "SupaSync history";
  }
  override async onOpen() {
    this.containerEl.empty();
    const root = this.containerEl.createDiv({ cls: "supasync-history" });
    root.createEl("h2", { text: "History" });
    try {
      const items = await this.read();
      if (!items.length)
        root.createEl("p", {
          text: "Select a synced file to inspect history.",
        });
      for (const item of items.reverse()) {
        const row = root.createDiv();
        row.createEl("p", {
          text: `${item.path} — revision ${item.seq} — ${item.serverTime}`,
        });
        if (!item.tombstone) {
          const button = row.createEl("button", {
            text: "Restore this version",
          });
          button.onclick = async () => {
            button.disabled = true;
            try {
              await this.restore(item.seq);
              await this.onOpen();
            } catch (error) {
              root.createEl("p", {
                text: error instanceof Error ? error.message : "Restore failed",
              });
              button.disabled = false;
            }
          };
        }
      }
    } catch (error) {
      root.createEl("p", {
        text: error instanceof Error ? error.message : "History unavailable",
      });
    }
  }
}
