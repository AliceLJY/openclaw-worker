import { execSync, exec } from "child_process";
import { promisify } from "util";
import { ClipboardStorage, ClipboardEntry, ClipboardType } from "./storage.js";
import * as crypto from "crypto";

const execAsync = promisify(exec);

export class ClipboardMonitor {
  private storage: ClipboardStorage;
  private intervalId: NodeJS.Timeout | null = null;
  private lastChangeCount: number = -1;
  private isRunning: boolean = false;

  constructor(storage: ClipboardStorage) {
    this.storage = storage;
  }

  /**
   * Get the current pasteboard change count using AppleScript
   * This is more reliable than polling content directly
   */
  private async getChangeCount(): Promise<number> {
    try {
      const script = `
        use framework "AppKit"
        set pb to current application's NSPasteboard's generalPasteboard()
        return pb's changeCount() as integer
      `;
      const { stdout } = await execAsync(`osascript -e '${script}'`);
      return parseInt(stdout.trim(), 10);
    } catch {
      return -1;
    }
  }

  /**
   * Get the current clipboard content
   */
  async getCurrentClipboard(): Promise<ClipboardEntry | null> {
    try {
      // Try to get text content first
      const textContent = await this.getTextContent();
      if (textContent) {
        return {
          id: crypto.randomUUID(),
          type: "text",
          content: textContent,
          timestamp: Date.now(),
          app: await this.getFrontmostApp(),
        };
      }

      // Check for image content
      const hasImage = await this.hasImageContent();
      if (hasImage) {
        const imageInfo = await this.getImageInfo();
        return {
          id: crypto.randomUUID(),
          type: "image",
          content: imageInfo || "[Image in clipboard]",
          timestamp: Date.now(),
          app: await this.getFrontmostApp(),
          metadata: {
            hasImage: true,
          },
        };
      }

      // Check for file paths
      const filePaths = await this.getFilePaths();
      if (filePaths && filePaths.length > 0) {
        return {
          id: crypto.randomUUID(),
          type: "file",
          content: filePaths.join("\n"),
          timestamp: Date.now(),
          app: await this.getFrontmostApp(),
          metadata: {
            fileCount: filePaths.length,
            files: filePaths,
          },
        };
      }

      return null;
    } catch (error) {
      console.error("Error getting clipboard content:", error);
      return null;
    }
  }

  /**
   * Get text content from clipboard using pbpaste
   */
  private async getTextContent(): Promise<string | null> {
    try {
      const { stdout } = await execAsync("pbpaste", { maxBuffer: 10 * 1024 * 1024 });
      return stdout || null;
    } catch {
      return null;
    }
  }

  /**
   * Check if clipboard has image content
   */
  private async hasImageContent(): Promise<boolean> {
    try {
      const script = `
        use framework "AppKit"
        set pb to current application's NSPasteboard's generalPasteboard()
        set types to pb's types() as list
        if types contains "public.png" or types contains "public.tiff" or types contains "public.jpeg" then
          return true
        else
          return false
        end if
      `;
      const { stdout } = await execAsync(`osascript -e '${script}'`);
      return stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  /**
   * Get image info from clipboard
   */
  private async getImageInfo(): Promise<string | null> {
    try {
      const script = `
        use framework "AppKit"
        use framework "Foundation"

        set pb to current application's NSPasteboard's generalPasteboard()
        set imgData to pb's dataForType:"public.png"

        if imgData is missing value then
          set imgData to pb's dataForType:"public.tiff"
        end if

        if imgData is missing value then
          return "Image (unknown format)"
        end if

        set img to current application's NSImage's alloc()'s initWithData:imgData
        if img is missing value then
          return "Image (could not load)"
        end if

        set imgSize to img's |size|()
        set w to round ((item 1 of imgSize) as real)
        set h to round ((item 2 of imgSize) as real)

        return "Image (" & w & "x" & h & ")"
      `;
      const { stdout } = await execAsync(`osascript -e '${script}'`);
      return stdout.trim();
    } catch {
      return "[Image]";
    }
  }

  /**
   * Get file paths from clipboard
   */
  private async getFilePaths(): Promise<string[] | null> {
    try {
      const script = `
        use framework "AppKit"
        set pb to current application's NSPasteboard's generalPasteboard()
        set fileURLs to pb's readObjectsForClasses:{current application's NSURL} options:(missing value)
        if fileURLs is missing value then
          return ""
        end if
        set paths to {}
        repeat with fileURL in fileURLs
          set end of paths to (fileURL's |path|() as text)
        end repeat
        return paths as text
      `;
      const { stdout } = await execAsync(`osascript -e '${script}'`);
      const result = stdout.trim();
      if (!result) return null;
      return result.split(", ").filter((p) => p.length > 0);
    } catch {
      return null;
    }
  }

  /**
   * Get the frontmost application name
   */
  private async getFrontmostApp(): Promise<string | undefined> {
    try {
      const script = `
        tell application "System Events"
          set frontApp to name of first application process whose frontmost is true
        end tell
        return frontApp
      `;
      const { stdout } = await execAsync(`osascript -e '${script}'`);
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Copy text to clipboard using pbcopy
   */
  async copyToClipboard(text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = exec("pbcopy");
      proc.stdin?.write(text);
      proc.stdin?.end();
      proc.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`pbcopy exited with code ${code}`));
        }
      });
    });
  }

  /**
   * Start monitoring clipboard changes
   */
  start(intervalMs: number = 500): void {
    if (this.isRunning) {
      console.error("Clipboard monitor is already running");
      return;
    }

    this.isRunning = true;
    console.error(`Starting clipboard monitor with ${intervalMs}ms interval`);

    this.intervalId = setInterval(async () => {
      try {
        const currentChangeCount = await this.getChangeCount();

        if (currentChangeCount !== this.lastChangeCount && this.lastChangeCount !== -1) {
          const entry = await this.getCurrentClipboard();
          if (entry) {
            // Check if this content is already the most recent entry
            const history = this.storage.getHistory(1);
            if (history.length === 0 || history[0].content !== entry.content) {
              this.storage.add(entry);
              console.error(`New clipboard entry: ${entry.type} - ${entry.content.substring(0, 50)}...`);
            }
          }
        }

        this.lastChangeCount = currentChangeCount;
      } catch (error) {
        console.error("Error monitoring clipboard:", error);
      }
    }, intervalMs);
  }

  /**
   * Stop monitoring clipboard changes
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    console.error("Clipboard monitor stopped");
  }

  /**
   * Check if monitor is running
   */
  isMonitoring(): boolean {
    return this.isRunning;
  }
}
