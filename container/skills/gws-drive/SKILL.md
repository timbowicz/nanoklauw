---
name: gws-drive
description: "List, search, upload, download, and manage Google Drive files and folders."
allowed-tools: Bash(gws:*)
---

# Google Drive — gws drive

Prerequisite: read the gws-shared skill for auth and CLI basics.

## Quick Start

```bash
# List recent files
gws drive files list

# Search for files
gws drive files list --params '{"q": "name contains '\''budget'\'' and mimeType = '\''application/vnd.google-apps.spreadsheet'\''"}'

# Upload a file
gws drive +upload --file /path/to/file.csv --name "My Data" --parent <FOLDER_ID>

# Download a file
gws drive files get --params '{"fileId": "<ID>", "alt": "media"}' -o downloaded.pdf
```

## Helper Commands

| Command | Description |
|---------|-------------|
| `gws drive +upload` | Upload a file with metadata |

## Common Operations

```bash
# List files (default: 10 results)
gws drive files list --params '{"pageSize": 25, "fields": "files(id,name,mimeType,modifiedTime)"}'

# Search by name
gws drive files list --params '{"q": "name = '\''Report.xlsx'\''"}'

# Search in a specific folder
gws drive files list --params '{"q": "'\''<FOLDER_ID>'\'' in parents"}'

# Get file metadata
gws drive files get --params '{"fileId": "<ID>", "fields": "id,name,mimeType,size,webViewLink"}'

# Create a folder
gws drive files create --json '{"name": "New Folder", "mimeType": "application/vnd.google-apps.folder"}'

# Move a file (update parents)
gws drive files update --params '{"fileId": "<ID>", "addParents": "<NEW_FOLDER_ID>", "removeParents": "<OLD_FOLDER_ID>"}'

# Delete a file
gws drive files delete --params '{"fileId": "<ID>"}'

# Export Google Doc as PDF
gws drive files export --params '{"fileId": "<ID>", "mimeType": "application/pdf"}' -o output.pdf

# Share a file
gws drive permissions create --params '{"fileId": "<ID>"}' \
  --json '{"role": "reader", "type": "user", "emailAddress": "user@example.com"}'
```

## MIME Types for Google Docs

| Google Type | MIME Type |
|-------------|-----------|
| Spreadsheet | `application/vnd.google-apps.spreadsheet` |
| Document | `application/vnd.google-apps.document` |
| Presentation | `application/vnd.google-apps.presentation` |
| Folder | `application/vnd.google-apps.folder` |

## Discovery

```bash
gws drive --help
gws schema drive.files.list
gws schema drive.files.create
```
