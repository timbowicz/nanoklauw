---
name: gws-sheets
description: "Read, write, create, and manage Google Sheets spreadsheets. Use for any spreadsheet task."
allowed-tools: Bash(gws:*)
---

# Google Sheets — gws sheets

Prerequisite: read the gws-shared skill for auth and CLI basics.

## Quick Start

```bash
# Read values from a spreadsheet
gws sheets +read --spreadsheet-id <ID> --range "Sheet1!A1:D10"

# Append rows to a spreadsheet
gws sheets +append --spreadsheet-id <ID> --range "Sheet1" --json '{"values": [["row1col1", "row1col2"]]}'

# Create a new spreadsheet
gws sheets spreadsheets create --json '{"properties": {"title": "My Sheet"}}'
```

## Helper Commands

| Command | Description |
|---------|-------------|
| `gws sheets +read` | Read values from a range |
| `gws sheets +append` | Append rows to a spreadsheet |

## API Resources

```bash
gws sheets --help              # Browse all resources
gws sheets spreadsheets --help # Spreadsheet operations
gws sheets values --help       # Cell value operations
```

### Common Operations

```bash
# Get spreadsheet metadata (sheets, properties)
gws sheets spreadsheets get --params '{"spreadsheetId": "<ID>"}'

# Read a range of values
gws sheets values get --params '{"spreadsheetId": "<ID>", "range": "Sheet1!A1:Z100"}'

# Write values to a range
gws sheets values update --params '{"spreadsheetId": "<ID>", "range": "Sheet1!A1", "valueInputOption": "USER_ENTERED"}' \
  --json '{"values": [["Name", "Score"], ["Alice", 95], ["Bob", 87]]}'

# Append rows
gws sheets values append --params '{"spreadsheetId": "<ID>", "range": "Sheet1", "valueInputOption": "USER_ENTERED"}' \
  --json '{"values": [["New Row", 42]]}'

# Batch update (multiple operations at once)
gws sheets spreadsheets batchUpdate --params '{"spreadsheetId": "<ID>"}' \
  --json '{"requests": [{"addSheet": {"properties": {"title": "NewTab"}}}]}'

# Clear a range
gws sheets values clear --params '{"spreadsheetId": "<ID>", "range": "Sheet1!A1:Z100"}'
```

## Finding Spreadsheet IDs

The spreadsheet ID is in the URL: `https://docs.google.com/spreadsheets/d/<SPREADSHEET_ID>/edit`

If the user gives you a URL, extract the ID from between `/d/` and `/edit`.

## Discovery

```bash
gws schema sheets.spreadsheets.values.update  # See required params for update
gws schema sheets.spreadsheets.batchUpdate     # See batch update request format
```
