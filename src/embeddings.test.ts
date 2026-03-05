import { describe, it, expect } from 'vitest';

describe('embeddings module', () => {
  it('exports EMBEDDING_DIM as 384', async () => {
    const { EMBEDDING_DIM } = await import('./embeddings.js');
    expect(EMBEDDING_DIM).toBe(384);
  });

  it('exports isEmbeddingModelLoaded', async () => {
    const { isEmbeddingModelLoaded } = await import('./embeddings.js');
    expect(typeof isEmbeddingModelLoaded).toBe('function');
    // Model not loaded yet in tests
    expect(isEmbeddingModelLoaded()).toBe(false);
  });

  it('exports loadEmbeddingModel function', async () => {
    const { loadEmbeddingModel } = await import('./embeddings.js');
    expect(typeof loadEmbeddingModel).toBe('function');
  });

  it('exports embed function', async () => {
    const { embed } = await import('./embeddings.js');
    expect(typeof embed).toBe('function');
  });
});
