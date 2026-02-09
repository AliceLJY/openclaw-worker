#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ClipboardMonitor } from "./clipboard-monitor.js";
import { ClipboardStorage, ClipboardEntry } from "./storage.js";

const server = new Server(
  {
    name: "clipboard-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

const storage = new ClipboardStorage();
const monitor = new ClipboardMonitor(storage);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "clipboard_get_current",
        description: "Get the current clipboard content",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "clipboard_get_history",
        description: "Get clipboard history with optional limit",
        inputSchema: {
          type: "object",
          properties: {
            limit: {
              type: "number",
              description: "Maximum number of entries to return (default: 50)",
            },
            type: {
              type: "string",
              enum: ["text", "image", "file", "all"],
              description: "Filter by content type (default: all)",
            },
          },
          required: [],
        },
      },
      {
        name: "clipboard_search",
        description: "Search clipboard history by keyword",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query string",
            },
            limit: {
              type: "number",
              description: "Maximum number of results (default: 20)",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "clipboard_copy",
        description: "Copy text to clipboard",
        inputSchema: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "Text to copy to clipboard",
            },
          },
          required: ["text"],
        },
      },
      {
        name: "clipboard_delete",
        description: "Delete a clipboard entry by ID",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "ID of the clipboard entry to delete",
            },
          },
          required: ["id"],
        },
      },
      {
        name: "clipboard_clear_history",
        description: "Clear all clipboard history",
        inputSchema: {
          type: "object",
          properties: {
            confirm: {
              type: "boolean",
              description: "Must be true to confirm clearing history",
            },
          },
          required: ["confirm"],
        },
      },
      {
        name: "clipboard_start_monitoring",
        description: "Start monitoring clipboard changes",
        inputSchema: {
          type: "object",
          properties: {
            interval: {
              type: "number",
              description: "Polling interval in milliseconds (default: 500)",
            },
          },
          required: [],
        },
      },
      {
        name: "clipboard_stop_monitoring",
        description: "Stop monitoring clipboard changes",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "clipboard_get_stats",
        description: "Get clipboard history statistics",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    ],
  };
});

// List available resources
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: "clipboard://history",
        name: "Clipboard History",
        description: "Full clipboard history data",
        mimeType: "application/json",
      },
      {
        uri: "clipboard://current",
        name: "Current Clipboard",
        description: "Current clipboard content",
        mimeType: "application/json",
      },
    ],
  };
});

// Read resources
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  if (uri === "clipboard://history") {
    const history = storage.getHistory();
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(history, null, 2),
        },
      ],
    };
  }

  if (uri === "clipboard://current") {
    const current = await monitor.getCurrentClipboard();
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(current, null, 2),
        },
      ],
    };
  }

  throw new Error(`Unknown resource: ${uri}`);
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "clipboard_get_current": {
        const current = await monitor.getCurrentClipboard();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(current, null, 2),
            },
          ],
        };
      }

      case "clipboard_get_history": {
        const limit = (args?.limit as number) || 50;
        const type = (args?.type as string) || "all";
        let history = storage.getHistory(limit);

        if (type !== "all") {
          history = history.filter((entry) => entry.type === type);
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(history, null, 2),
            },
          ],
        };
      }

      case "clipboard_search": {
        const query = args?.query as string;
        const limit = (args?.limit as number) || 20;

        if (!query) {
          throw new Error("Query is required");
        }

        const results = storage.search(query, limit);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(results, null, 2),
            },
          ],
        };
      }

      case "clipboard_copy": {
        const text = args?.text as string;
        if (!text) {
          throw new Error("Text is required");
        }

        await monitor.copyToClipboard(text);
        return {
          content: [
            {
              type: "text",
              text: "Text copied to clipboard successfully",
            },
          ],
        };
      }

      case "clipboard_delete": {
        const id = args?.id as string;
        if (!id) {
          throw new Error("ID is required");
        }

        const deleted = storage.delete(id);
        return {
          content: [
            {
              type: "text",
              text: deleted
                ? "Entry deleted successfully"
                : "Entry not found",
            },
          ],
        };
      }

      case "clipboard_clear_history": {
        const confirm = args?.confirm as boolean;
        if (!confirm) {
          throw new Error("Must set confirm to true to clear history");
        }

        storage.clear();
        return {
          content: [
            {
              type: "text",
              text: "Clipboard history cleared",
            },
          ],
        };
      }

      case "clipboard_start_monitoring": {
        const interval = (args?.interval as number) || 500;
        monitor.start(interval);
        return {
          content: [
            {
              type: "text",
              text: `Clipboard monitoring started with ${interval}ms interval`,
            },
          ],
        };
      }

      case "clipboard_stop_monitoring": {
        monitor.stop();
        return {
          content: [
            {
              type: "text",
              text: "Clipboard monitoring stopped",
            },
          ],
        };
      }

      case "clipboard_get_stats": {
        const stats = storage.getStats();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(stats, null, 2),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text",
          text: `Error: ${errorMessage}`,
        },
      ],
      isError: true,
    };
  }
});

// Start the server
async function main() {
  // Start clipboard monitoring by default
  monitor.start(500);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("Clipboard MCP Server started");
}

main().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
