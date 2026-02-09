# Clipboard MCP Server

A Model Context Protocol (MCP) server for macOS clipboard history management. This server monitors the system clipboard (NSPasteboard), stores history, and provides tools to search, retrieve, and manage clipboard content.

## Features

- **Real-time Clipboard Monitoring**: Automatically captures clipboard changes using NSPasteboard change count
- **Multi-type Support**: Handles text, images, and file references
- **Persistent Storage**: Stores history in `~/Library/Application Support/clipboard-mcp/data.json`
- **Search Functionality**: Full-text search through clipboard history
- **Source App Tracking**: Records which application the content was copied from
- **Configurable Retention**: Set maximum entries and retention period

## Requirements

- macOS (uses NSPasteboard via AppleScript)
- Node.js 18+
- npm or yarn

## Installation

```bash
cd ~/Projects/openclaw-worker/mcp/clipboard

# Install dependencies
npm install

# Build TypeScript
npm run build
```

## Usage

### Start the Server

```bash
npm start
```

Or for development:

```bash
npm run dev
```

### Configure in Claude Desktop

Add to your Claude Desktop configuration (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "clipboard": {
      "command": "node",
      "args": ["/Users/YOUR_USERNAME/Projects/openclaw-worker/mcp/clipboard/dist/index.js"]
    }
  }
}
```

## Available Tools

### clipboard_get_current
Get the current clipboard content.

### clipboard_get_history
Get clipboard history with optional filtering.
- `limit`: Maximum number of entries (default: 50)
- `type`: Filter by type - "text", "image", "file", or "all"

### clipboard_search
Search clipboard history by keyword.
- `query`: Search query string (required)
- `limit`: Maximum results (default: 20)

### clipboard_copy
Copy text to clipboard.
- `text`: Text to copy (required)

### clipboard_delete
Delete a clipboard entry by ID.
- `id`: Entry ID (required)

### clipboard_clear_history
Clear all clipboard history.
- `confirm`: Must be `true` to confirm (required)

### clipboard_start_monitoring
Start monitoring clipboard changes.
- `interval`: Polling interval in milliseconds (default: 500)

### clipboard_stop_monitoring
Stop monitoring clipboard changes.

### clipboard_get_stats
Get clipboard history statistics including:
- Total entries count
- Breakdown by type (text/image/file)
- Oldest and newest entry timestamps
- Storage file size

## Resources

The server also exposes MCP resources:

- `clipboard://history` - Full clipboard history as JSON
- `clipboard://current` - Current clipboard content

## Data Storage

History is stored in:
```
~/Library/Application Support/clipboard-mcp/data.json
```

### Storage Format

```json
{
  "version": 1,
  "entries": [
    {
      "id": "uuid",
      "type": "text",
      "content": "clipboard content",
      "timestamp": 1234567890,
      "app": "Safari"
    }
  ],
  "settings": {
    "maxEntries": 1000,
    "retentionDays": 30
  }
}
```

## Permissions

The server requires the following macOS permissions:
- **Accessibility** (optional): For detecting the source application
- **Automation**: For AppleScript access to NSPasteboard

If prompted, grant these permissions in System Preferences > Security & Privacy > Privacy.

## Development

```bash
# Watch mode for development
npm run watch

# Build
npm run build
```

## Troubleshooting

### Clipboard not being captured
1. Ensure the server is running
2. Check that monitoring is started (`clipboard_start_monitoring`)
3. Verify AppleScript permissions are granted

### Permission errors
Run in Terminal:
```bash
osascript -e 'tell application "System Events" to get name of first process'
```
If this prompts for permissions, grant them.

## License

MIT
