import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/test-data',
}));

vi.mock('./db.js', () => ({
  updateMessageContent: vi.fn(),
}));

// Must use vi.hoisted so these are available inside the hoisted vi.mock factory
const {
  mockToBuffer,
  mockPng,
  mockJpeg,
  mockResize,
  mockMetadata,
  mockSharp,
} = vi.hoisted(() => {
  const mockToBuffer = vi.fn();
  const mockPng = vi.fn();
  const mockJpeg = vi.fn();
  const mockResize = vi.fn();
  const mockMetadata = vi.fn();

  function createChain() {
    const chain = {
      metadata: mockMetadata,
      resize: mockResize,
      png: mockPng,
      jpeg: mockJpeg,
      toBuffer: mockToBuffer,
    };
    mockResize.mockReturnValue(chain);
    mockPng.mockReturnValue(chain);
    mockJpeg.mockReturnValue(chain);
    return chain;
  }

  const mockSharp = vi.fn(() => createChain());

  return { mockToBuffer, mockPng, mockJpeg, mockResize, mockMetadata, mockSharp };
});

vi.mock('sharp', () => ({
  default: mockSharp,
}));

import { resizeImage } from './media-processing.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resizeImage', () => {
  it('resizes a large JPEG and outputs JPEG', async () => {
    const input = Buffer.from('fake-jpeg-data');
    const output = Buffer.from('resized-jpeg');

    mockMetadata.mockResolvedValue({ width: 2048, height: 1536, hasAlpha: false });
    mockToBuffer.mockResolvedValue(output);

    const result = await resizeImage(input, 'image/jpeg');

    expect(result).not.toBeNull();
    expect(result!.buffer).toBe(output);
    expect(result!.mimetype).toBe('image/jpeg');
    expect(mockResize).toHaveBeenCalledWith(1024, 1024, {
      fit: 'inside',
      withoutEnlargement: true,
    });
    expect(mockJpeg).toHaveBeenCalledWith({ quality: 85 });
    expect(mockPng).not.toHaveBeenCalled();
  });

  it('keeps PNG format when image has alpha channel', async () => {
    const input = Buffer.from('fake-png-data');
    const output = Buffer.from('resized-png');

    mockMetadata.mockResolvedValue({ width: 2000, height: 1000, hasAlpha: true });
    mockToBuffer.mockResolvedValue(output);

    const result = await resizeImage(input, 'image/png');

    expect(result).not.toBeNull();
    expect(result!.buffer).toBe(output);
    expect(result!.mimetype).toBe('image/png');
    expect(mockPng).toHaveBeenCalled();
    expect(mockJpeg).not.toHaveBeenCalled();
  });

  it('converts PNG without alpha to JPEG', async () => {
    const input = Buffer.from('fake-png-no-alpha');
    const output = Buffer.from('converted-jpeg');

    mockMetadata.mockResolvedValue({ width: 800, height: 600, hasAlpha: false });
    mockToBuffer.mockResolvedValue(output);

    const result = await resizeImage(input, 'image/png');

    expect(result).not.toBeNull();
    expect(result!.mimetype).toBe('image/jpeg');
    expect(mockJpeg).toHaveBeenCalledWith({ quality: 85 });
  });

  it('does not enlarge small images (withoutEnlargement)', async () => {
    const input = Buffer.from('small-image');
    const output = Buffer.from('same-size');

    mockMetadata.mockResolvedValue({ width: 640, height: 480, hasAlpha: false });
    mockToBuffer.mockResolvedValue(output);

    const result = await resizeImage(input, 'image/jpeg');

    expect(result).not.toBeNull();
    expect(mockResize).toHaveBeenCalledWith(1024, 1024, {
      fit: 'inside',
      withoutEnlargement: true,
    });
  });

  it('converts WebP to JPEG', async () => {
    const input = Buffer.from('fake-webp');
    const output = Buffer.from('converted');

    mockMetadata.mockResolvedValue({ width: 3000, height: 2000, hasAlpha: false });
    mockToBuffer.mockResolvedValue(output);

    const result = await resizeImage(input, 'image/webp');

    expect(result).not.toBeNull();
    expect(result!.mimetype).toBe('image/jpeg');
  });

  it('returns original buffer when metadata has no dimensions', async () => {
    const input = Buffer.from('weird-image');
    mockMetadata.mockResolvedValue({ width: undefined, height: undefined });

    const result = await resizeImage(input, 'image/jpeg');

    expect(result).not.toBeNull();
    expect(result!.buffer).toBe(input);
    expect(result!.mimetype).toBe('image/jpeg');
    expect(mockResize).not.toHaveBeenCalled();
  });

  it('returns original on sharp error', async () => {
    const input = Buffer.from('corrupt-image');
    mockMetadata.mockRejectedValue(new Error('Invalid image'));

    const result = await resizeImage(input, 'image/jpeg');

    expect(result).not.toBeNull();
    expect(result!.buffer).toBe(input);
    expect(result!.mimetype).toBe('image/jpeg');
  });
});
