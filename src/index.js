import http from 'node:http';
import { config } from './config.js';
import { transformAnthropicRequestToOpenAI, transformOpenAIToAnthropicResponse } from './transformers.js';
import { streamOpenAIToAnthropic } from './stream-adapter.js';

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta');
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error(`Invalid JSON body: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // 1. Health check & Info
  if (req.method === 'GET' && (pathname === '/' || pathname === '/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'Claude Code NVIDIA Middleware',
      target: config.nvidiaBaseUrl,
      defaultModel: config.defaultModel,
      apiKeyConfigured: Boolean(config.nvidiaApiKey)
    }, null, 2));
    return;
  }

  // 2. Models list
  if (req.method === 'GET' && (pathname === '/v1/models' || pathname === '/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      data: [
        { id: 'meta/llama-3.3-70b-instruct', object: 'model' },
        { id: 'qwen/qwen2.5-coder-32b-instruct', object: 'model' },
        { id: 'deepseek-ai/deepseek-r1', object: 'model' },
        { id: 'mistralai/mistral-large-2-instruct', object: 'model' }
      ]
    }));
    return;
  }

  // 3. Token counting mock
  if (req.method === 'POST' && (pathname === '/v1/messages/count_tokens' || pathname === '/messages/count_tokens')) {
    try {
      const body = await parseJsonBody(req);
      const text = JSON.stringify(body);
      const estimatedTokens = Math.max(1, Math.ceil(text.length / 4));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: estimatedTokens }));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: 100 }));
    }
    return;
  }

  // 4. Main Messages Endpoint (POST /v1/messages or POST /messages)
  if (req.method === 'POST' && (pathname === '/v1/messages' || pathname === '/messages')) {
    const startTime = Date.now();

    try {
      const anthropicBody = await parseJsonBody(req);
      const requestedModel = anthropicBody.model || 'claude-3-5-sonnet-20241022';

      // Transform to OpenAI format
      const { targetModel, payload } = transformAnthropicRequestToOpenAI(anthropicBody);

      // Verify API Key
      // Check either Authorization header from Claude Code, or x-api-key, or configured env key
      const clientAuth = req.headers['authorization']?.replace(/^Bearer\s+/i, '') || req.headers['x-api-key'];
      const apiKey = (config.nvidiaApiKey && config.nvidiaApiKey !== 'dummy') ? config.nvidiaApiKey : clientAuth;

      if (!apiKey || apiKey === 'dummy') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            type: 'authentication_error',
            message: 'NVIDIA API key not set. Please set NVIDIA_API_KEY in .env or pass it in ANTHROPIC_API_KEY.'
          }
        }));
        return;
      }

      console.log(`\n[${new Date().toLocaleTimeString()}] 📨 Incoming Request:`);
      console.log(`  Requested Model : ${requestedModel}`);
      console.log(`  Target NIM Model: ${targetModel}`);
      console.log(`  Messages Count  : ${payload.messages.length}`);
      console.log(`  Tools Provided  : ${payload.tools?.length || 0}`);
      console.log(`  Streaming       : ${payload.stream}`);

      // Forward to NVIDIA NIM
      const nvidiaUrl = `${config.nvidiaBaseUrl}/chat/completions`;
      const nvidiaResponse = await fetch(nvidiaUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(payload)
      });

      if (!nvidiaResponse.ok) {
        const errorText = await nvidiaResponse.text();
        console.error(`❌ NVIDIA NIM Error (${nvidiaResponse.status}):`, errorText);

        res.writeHead(nvidiaResponse.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            type: 'api_error',
            message: `NVIDIA NIM responded with ${nvidiaResponse.status}: ${errorText}`
          }
        }));
        return;
      }

      // Handle streaming vs non-streaming
      if (payload.stream) {
        await streamOpenAIToAnthropic(nvidiaResponse, res, requestedModel);
        console.log(`  ⚡ Stream completed in ${Date.now() - startTime}ms`);
      } else {
        const data = await nvidiaResponse.json();
        const anthropicResponse = transformOpenAIToAnthropicResponse(data, requestedModel);
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01'
        });
        res.end(JSON.stringify(anthropicResponse));
        console.log(`  ✅ Response returned in ${Date.now() - startTime}ms`);
      }
    } catch (err) {
      console.error('❌ Server error handling request:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            type: 'internal_error',
            message: err.message
          }
        }));
      }
    }
    return;
  }

  // Not found
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: `Route ${req.method} ${pathname} not found` } }));
});

server.listen(config.port, config.host, () => {
  console.log('====================================================');
  console.log('  🚀 Claude Code -> NVIDIA NIM Middleware Proxy');
  console.log('====================================================');
  console.log(`  Listening at   : http://${config.host}:${config.port}`);
  console.log(`  NVIDIA Endpoint: ${config.nvidiaBaseUrl}`);
  console.log(`  Default Model  : ${config.defaultModel}`);
  console.log(`  API Key Status : ${config.nvidiaApiKey ? 'Configured ✅' : 'Missing ⚠️ (Provide in .env)'}`);
  console.log('====================================================');
  console.log('  To connect Claude Code:');
  console.log(`  export ANTHROPIC_BASE_URL="http://${config.host}:${config.port}"`);
  console.log('  export ANTHROPIC_API_KEY="dummy"');
  console.log('  claude');
  console.log('====================================================\n');
});

