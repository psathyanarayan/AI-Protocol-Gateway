export const config = {
  port: parseInt(process.env.PORT || '8080', 10),
  host: process.env.HOST || '127.0.0.1',
  nvidiaApiKey: process.env.NVIDIA_API_KEY || '',
  nvidiaBaseUrl: (process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/+$/, ''),
  defaultModel: process.env.DEFAULT_MODEL || 'meta/llama-3.3-70b-instruct',
  logLevel: process.env.LOG_LEVEL || 'info', // 'debug' | 'info' | 'error'
  // Model mapping: map requested Anthropic model to an NVIDIA NIM model
  modelMapping: {
    'claude-3-7-sonnet-20250219': process.env.MODEL_SONNET || 'meta/llama-3.3-70b-instruct',
    'claude-3-5-sonnet-20241022': process.env.MODEL_SONNET || 'meta/llama-3.3-70b-instruct',
    'claude-3-5-sonnet-20240620': process.env.MODEL_SONNET || 'meta/llama-3.3-70b-instruct',
    'claude-3-5-haiku-20241022': process.env.MODEL_HAIKU || 'meta/llama-3.3-70b-instruct',
    'claude-3-haiku-20240307': process.env.MODEL_HAIKU || 'meta/llama-3.3-70b-instruct',
    'claude-3-opus-20240229': process.env.MODEL_OPUS || 'meta/llama-3.3-70b-instruct'
  }
};

export function resolveModel(requestedModel) {
  if (config.modelMapping[requestedModel]) {
    return config.modelMapping[requestedModel];
  }
  return config.defaultModel;
}

