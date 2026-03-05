/**
 * Shared embedding service for NanoClaw.
 *
 * Provides a singleton embedding pipeline using @huggingface/transformers
 * with Xenova/all-MiniLM-L6-v2 (384-dim). Used by both document-index and
 * memory systems to avoid loading the model twice.
 */

import path from 'path';

import { logger } from './logger.js';

export const EMBEDDING_DIM = 384;

let embeddingPipeline: any = null;

export async function loadEmbeddingModel(): Promise<void> {
  if (embeddingPipeline) return;
  const { pipeline } = await import('@huggingface/transformers');
  embeddingPipeline = await pipeline(
    'feature-extraction',
    'Xenova/all-MiniLM-L6-v2',
    {
      cache_dir: path.join(process.cwd(), 'data', 'models'),
    },
  );
  logger.info('Embedding model loaded');
}

export async function embed(text: string): Promise<Float32Array> {
  if (!embeddingPipeline) {
    await loadEmbeddingModel();
  }
  const output = await embeddingPipeline(text, {
    pooling: 'mean',
    normalize: true,
  });
  return new Float32Array(output.data);
}

export function isEmbeddingModelLoaded(): boolean {
  return embeddingPipeline !== null;
}
