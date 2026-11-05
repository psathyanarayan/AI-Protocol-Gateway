import assert from 'node:assert';
import { streamOpenAIToAnthropic } from '../src/stream-adapter.js';
import { Readable } from 'node:stream';

console.log('--- Running Streaming Adapter Unit Test ---');

// Mock response chunks from OpenAI / NVIDIA
const mockChunks = [
  'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
  'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
  'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":" world!"},"finish_reason":null}]}\n\n',
  'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_01","type":"function","function":{"name":"Bash","arguments":""}}]},"finish_reason":null}]}\n\n',
  'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"cmd\\":\\"date\\"}"}}]},"finish_reason":null}]}\n\n',
  'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
  'data: [DONE]\n\n'
];

// Create readable web stream
const stream = new ReadableStream({
  start(controller) {
    const encoder = new TextEncoder();
    for (const chunk of mockChunks) {
      controller.enqueue(encoder.encode(chunk));
    }
    controller.close();
  }
});

const mockOpenAIResponse = {
  body: stream
};

// Mock HTTP response object
const writtenEvents = [];
let headers = {};
const mockRes = {
  setHeader(k, v) { headers[k] = v; },
  write(data) {
    // Collect SSE events
    writtenEvents.push(data);
  },
  end() {
    // Stream completed
  }
};

await streamOpenAIToAnthropic(mockOpenAIResponse, mockRes, 'claude-3-5-sonnet-20241022');

const fullOutput = writtenEvents.join('');
assert(fullOutput.includes('event: message_start'), 'Must include message_start');
assert(fullOutput.includes('event: content_block_start'), 'Must include content_block_start');
assert(fullOutput.includes('event: content_block_delta'), 'Must include content_block_delta');
assert(fullOutput.includes('Hello'), 'Must stream text delta');
assert(fullOutput.includes('event: content_block_stop'), 'Must include content_block_stop');
assert(fullOutput.includes('"name":"Bash"'), 'Must stream tool block');
assert(fullOutput.includes('event: message_delta'), 'Must include message_delta');
assert(fullOutput.includes('"stop_reason":"tool_use"'), 'Stop reason must be tool_use');
assert(fullOutput.includes('event: message_stop'), 'Must include message_stop');

console.log('✓ Stream adapter test passed! Correct Anthropic SSE sequence emitted.');

