---
name: nano-banana
description: Generate and send AI images, or edit existing images. Use when the user asks to generate, create, make, or edit an image/picture/photo.
---

# Image Generation & Editing

You have MCP tools for image generation, editing, and sending:

## Workflow

**New image from scratch:**
1. Call `generate_image` with the user's prompt

**Edit an existing image (e.g., user sent a photo):**
1. Call `edit_image` with the image path and editing instructions
   - The input image is typically in `/workspace/ipc/media/` (received media from the chat)

## generate_image

| Parameter | Default | Notes |
|-----------|---------|-------|
| `prompt` | (required) | English only, max 480 tokens. Be descriptive. |
| `model` | `fast` | `fast` $0.02, `standard` $0.04, `ultra` $0.06 |
| `aspect_ratio` | `1:1` | `1:1`, `3:4`, `4:3`, `9:16`, `16:9` |
| `number_of_images` | `1` | 1-4 per call |

## edit_image

Edit/transform an existing image using AI. Use when a user sends a photo and wants modifications.

| Parameter | Default | Notes |
|-----------|---------|-------|
| `prompt` | (required) | English editing instruction. Be specific about changes. |
| `image_path` | (required) | Path to input image (e.g., `/workspace/ipc/media/abc123.jpg`) |
| `model` | `gemini-2.5-flash-image` | `gemini-2.5-flash-image` (fast/cheap) or `gemini-3-pro-image-preview` (higher quality) |
| `caption` | (optional) | Caption to send with the edited image |

**When to use:** User sends a photo and asks for changes — "make this more modern", "change the color", "add plants", "redesign this room", etc.

## send_image

| Parameter | Notes |
|-----------|-------|
| `image_path` | Absolute path from generate_image output |
| `caption` | Optional description |

## Model Selection

- **Default to `fast`** for all requests ($0.02/image)
- Use `standard` when user says "high quality", "detailed", or "better" ($0.04)
- Use `ultra` only when user explicitly asks for "best quality", "ultra", or "maximum quality" ($0.06)

## Aspect Ratio Selection

- Portraits/people: `3:4` or `9:16`
- Landscapes/scenery: `16:9` or `4:3`
- Logos/icons/general: `1:1`

## Prompt Tips

- Translate non-English requests to English for the prompt
- Add style descriptors: "photorealistic", "digital art", "watercolor", etc.
- Include lighting, composition, and mood details
- Keep prompts focused and specific

## Error Handling

- **Safety filter**: Rephrase and retry. Don't argue with the filter.
- **Quota/rate limit**: Wait a moment and retry.
- **No images returned**: Simplify the prompt and retry.
