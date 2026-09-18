import { ItemView, WorkspaceLeaf } from "obsidian";

export const STATUS_VIEW = "supasync-status";
export const CONFLICT_VIEW = "supasync-conflicts";
export const HISTORY_VIEW = "supasync-history";

export class StatusView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private readonly read: () => string,
  ) {
    super(leaf);
  }
  getViewType(): string {
    return STATUS_VIEW;
  }
  getDisplayText(): string {
    return "SupaSync status";
  }
  override async onOpen(): Promise<void> {
    this.containerEl.empty();
    const root = this.containerEl.createDiv({ cls: "supasync-status" });
    root.createEl("h2", { text: "SupaSync" });
    root.createEl("pre", { text: this.read() });
  }
}

export class ConflictView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private readonly read: () => string,
  ) {
    super(leaf);
  }
  getViewType(): string {
    return CONFLICT_VIEW;
  }
  getDisplayText(): string {
    return "SupaSync conflicts";
  }
  override async onOpen(): Promise<void> {
    this.containerEl.empty();
    const root = this.containerEl.createDiv({ cls: "supasync-conflicts" });
    root.createEl("h2", { text: "Conflicts" });
    root.createEl("pre", { text: this.read() || "No unresolved conflicts." });
  }
}

export class HistoryView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private readonly read: () => string,
  ) {
    super(leaf);
  }
  getViewType(): string {
    return HISTORY_VIEW;
  }
  getDisplayText(): string {
    return "SupaSync history";
  }
  override async onOpen(): Promise<void> {
    this.containerEl.empty();
    const root = this.containerEl.createDiv({ cls: "supasync-history" });
    root.createEl("h2", { text: "History" });
    root.createEl("pre", { text: this.read() || "Select a synced note to inspect history." });
  }
}
