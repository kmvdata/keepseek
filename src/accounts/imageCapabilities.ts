/** Verified adapter contract, deliberately narrower than the provider's entire API. */
export interface ImageModelCapabilities {
  version: 1;
  adapter: 'openai-images-v1';
  operations: ['generate', 'edit'];
  maxInputImages: 1;
  inputMimeTypes: ['image/png', 'image/jpeg', 'image/webp'];
  maxInputBytes: number;
  maxInputPixels: number;
  maxInputDimension: number;
  animatedInput: false;
  interlacedPngInput: false;
  outputFormats: ['png', 'jpeg', 'webp'];
  sizes: ['1024x1024', '1536x1024', '1024x1536'];
  qualities: ['low', 'medium', 'high'];
  backgrounds: ['opaque', 'transparent'];
  maxPromptChars: number;
  outputCount: 1;
  submission: 'synchronous';
  result: 'base64';
  queryable: false;
  serverCancellation: false;
}

export const OPENAI_IMAGE_MODEL_ID = 'gpt-image-2.5-sunburst';
export const OPENAI_IMAGES_ENDPOINT_ID = 'https://api.openai.com/v1';

/** Capability facts are recognized only for a verified model, never arbitrary persisted flags. */
export function getImageModelCapabilities(modelId: string): ImageModelCapabilities | undefined {
  if (modelId !== OPENAI_IMAGE_MODEL_ID) return undefined;
  return {
    version: 1,
    adapter: 'openai-images-v1',
    operations: ['generate', 'edit'],
    maxInputImages: 1,
    inputMimeTypes: ['image/png', 'image/jpeg', 'image/webp'],
    maxInputBytes: 20 * 1024 * 1024,
    maxInputPixels: 40_000_000,
    maxInputDimension: 16_384,
    animatedInput: false,
    interlacedPngInput: false,
    outputFormats: ['png', 'jpeg', 'webp'],
    sizes: ['1024x1024', '1536x1024', '1024x1536'],
    qualities: ['low', 'medium', 'high'],
    backgrounds: ['opaque', 'transparent'],
    maxPromptChars: 32_000,
    outputCount: 1,
    submission: 'synchronous',
    result: 'base64',
    queryable: false,
    serverCancellation: false
  };
}

/** No endpoint guessing, query credentials, redirects, other domains or text-route suffixes. */
export function normalizeOpenAIImagesEndpoint(rawBaseUrl: string): string | undefined {
  try {
    const url = new URL(rawBaseUrl.trim());
    if (url.protocol !== 'https:' || url.hostname !== 'api.openai.com'
      || url.port || url.username || url.password || url.search || url.hash
      || url.pathname.replace(/\/+$/u, '') !== '/v1') return undefined;
    return OPENAI_IMAGES_ENDPOINT_ID;
  } catch {
    return undefined;
  }
}
