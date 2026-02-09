import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export type ClipboardType = "text" | "image" | "file";

export interface ClipboardEntry {
  id: string;
  type: ClipboardType;
  content: string;
  timestamp: number;
  app?: string;
  metadata?: Record<string, unknown>;
}

export interface StorageData {
  version: number;
  entries: ClipboardEntry[];
  settings: {
    maxEntries: number;
    retentionDays: number;
  };
}

export interface ClipboardStats {
  totalEntries: number;
  textEntries: number;
  imageEntries: number;
  fileEntries: number;
  oldestEntry: number | null;
  newestEntry: number | null;
  storageSize: number;
}

const DEFAULT_SETTINGS = {
  maxEntries: 1000,
  retentionDays: 30,
};

export class ClipboardStorage {
  private dataDir: string;
  private dataFile: string;
  private data: StorageData;

  constructor() {
    // Use ~/Library/Application Support/clipboard-mcp/ on macOS
    this.dataDir = path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "clipboard-mcp"
    );
    this.dataFile = path.join(this.dataDir, "data.json");

    this.ensureDataDir();
    this.data = this.load();
    this.cleanupOldEntries();
  }

  /**
   * Ensure the data directory exists
   */
  private ensureDataDir(): void {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
      console.error(`Created data directory: ${this.dataDir}`);
    }
  }

  /**
   * Load data from file
   */
  private load(): StorageData {
    try {
      if (fs.existsSync(this.dataFile)) {
        const content = fs.readFileSync(this.dataFile, "utf-8");
        const data = JSON.parse(content) as StorageData;

        // Migrate if needed
        if (!data.version) {
          data.version = 1;
        }
        if (!data.settings) {
          data.settings = DEFAULT_SETTINGS;
        }

        return data;
      }
    } catch (error) {
      console.error("Error loading storage data:", error);
    }

    // Return default data
    return {
      version: 1,
      entries: [],
      settings: DEFAULT_SETTINGS,
    };
  }

  /**
   * Save data to file
   */
  private save(): void {
    try {
      const content = JSON.stringify(this.data, null, 2);
      fs.writeFileSync(this.dataFile, content, "utf-8");
    } catch (error) {
      console.error("Error saving storage data:", error);
    }
  }

  /**
   * Clean up old entries based on retention settings
   */
  private cleanupOldEntries(): void {
    const now = Date.now();
    const retentionMs = this.data.settings.retentionDays * 24 * 60 * 60 * 1000;
    const cutoff = now - retentionMs;

    const originalCount = this.data.entries.length;
    this.data.entries = this.data.entries.filter(
      (entry) => entry.timestamp > cutoff
    );

    // Also enforce max entries
    if (this.data.entries.length > this.data.settings.maxEntries) {
      this.data.entries = this.data.entries.slice(
        0,
        this.data.settings.maxEntries
      );
    }

    if (this.data.entries.length !== originalCount) {
      console.error(
        `Cleaned up ${originalCount - this.data.entries.length} old entries`
      );
      this.save();
    }
  }

  /**
   * Add a new clipboard entry
   */
  add(entry: ClipboardEntry): void {
    // Add to the beginning of the array (most recent first)
    this.data.entries.unshift(entry);

    // Enforce max entries limit
    if (this.data.entries.length > this.data.settings.maxEntries) {
      this.data.entries = this.data.entries.slice(
        0,
        this.data.settings.maxEntries
      );
    }

    this.save();
  }

  /**
   * Get clipboard history
   */
  getHistory(limit: number = 50): ClipboardEntry[] {
    return this.data.entries.slice(0, limit);
  }

  /**
   * Search clipboard history by keyword
   */
  search(query: string, limit: number = 20): ClipboardEntry[] {
    const lowerQuery = query.toLowerCase();
    return this.data.entries
      .filter((entry) => entry.content.toLowerCase().includes(lowerQuery))
      .slice(0, limit);
  }

  /**
   * Get a specific entry by ID
   */
  get(id: string): ClipboardEntry | undefined {
    return this.data.entries.find((entry) => entry.id === id);
  }

  /**
   * Delete an entry by ID
   */
  delete(id: string): boolean {
    const index = this.data.entries.findIndex((entry) => entry.id === id);
    if (index !== -1) {
      this.data.entries.splice(index, 1);
      this.save();
      return true;
    }
    return false;
  }

  /**
   * Clear all entries
   */
  clear(): void {
    this.data.entries = [];
    this.save();
  }

  /**
   * Get storage statistics
   */
  getStats(): ClipboardStats {
    const entries = this.data.entries;
    const textEntries = entries.filter((e) => e.type === "text").length;
    const imageEntries = entries.filter((e) => e.type === "image").length;
    const fileEntries = entries.filter((e) => e.type === "file").length;

    let storageSize = 0;
    try {
      const stats = fs.statSync(this.dataFile);
      storageSize = stats.size;
    } catch {
      // File might not exist yet
    }

    return {
      totalEntries: entries.length,
      textEntries,
      imageEntries,
      fileEntries,
      oldestEntry: entries.length > 0 ? entries[entries.length - 1].timestamp : null,
      newestEntry: entries.length > 0 ? entries[0].timestamp : null,
      storageSize,
    };
  }

  /**
   * Update settings
   */
  updateSettings(settings: Partial<StorageData["settings"]>): void {
    this.data.settings = {
      ...this.data.settings,
      ...settings,
    };
    this.save();
    this.cleanupOldEntries();
  }

  /**
   * Get current settings
   */
  getSettings(): StorageData["settings"] {
    return { ...this.data.settings };
  }

  /**
   * Export all data
   */
  export(): StorageData {
    return { ...this.data };
  }

  /**
   * Import data (merge with existing)
   */
  import(data: StorageData, replace: boolean = false): void {
    if (replace) {
      this.data = data;
    } else {
      // Merge entries, avoiding duplicates by ID
      const existingIds = new Set(this.data.entries.map((e) => e.id));
      const newEntries = data.entries.filter((e) => !existingIds.has(e.id));
      this.data.entries = [...this.data.entries, ...newEntries];

      // Sort by timestamp (newest first)
      this.data.entries.sort((a, b) => b.timestamp - a.timestamp);

      // Enforce limits
      if (this.data.entries.length > this.data.settings.maxEntries) {
        this.data.entries = this.data.entries.slice(
          0,
          this.data.settings.maxEntries
        );
      }
    }
    this.save();
  }
}
