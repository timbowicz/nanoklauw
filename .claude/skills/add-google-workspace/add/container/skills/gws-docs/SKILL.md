---
name: gws-docs
description: "Create, read, and write Google Docs documents."
allowed-tools: Bash(gws:*)
---

# Google Docs — gws docs

Prerequisite: read the gws-shared skill for auth and CLI basics.

## Quick Start

```bash
# Create a new document
gws docs documents create --json '{"title": "Meeting Notes"}'

# Read a document
gws docs documents get --params '{"documentId": "<ID>"}'

# Append text to a document
gws docs +write --document-id <ID> --text "New paragraph content"
```

## Helper Commands

| Command | Description |
|---------|-------------|
| `gws docs +write` | Append text to a document |

## Common Operations

```bash
# Create a blank document
gws docs documents create --json '{"title": "My Document"}'

# Get document content
gws docs documents get --params '{"documentId": "<ID>"}'

# Batch update (insert text, formatting, etc.)
gws docs documents batchUpdate --params '{"documentId": "<ID>"}' \
  --json '{"requests": [{"insertText": {"location": {"index": 1}, "text": "Hello World\n"}}]}'
```

## Finding Document IDs

The document ID is in the URL: `https://docs.google.com/document/d/<DOCUMENT_ID>/edit`

## Discovery

```bash
gws docs --help
gws schema docs.documents.batchUpdate
```
