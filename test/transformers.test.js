import assert from 'node:assert';
import { transformAnthropicRequestToOpenAI, transformOpenAIToAnthropicResponse } from '../src/transformers.js';

console.log('--- Running Transformer Unit Tests ---');

// Test 1: System prompt and user message
{
  const input = {
    model: 'claude-3-5-sonnet-20241022',
    system: 'You are a helpful coding assistant.',
    messages: [
      { role: 'user', content: 'Hello!' }
    ]
  };

  const { targetModel, payload } = transformAnthropicRequestToOpenAI(input);
  assert.strictEqual(targetModel, 'meta/llama-3.3-70b-instruct');
  assert.strictEqual(payload.messages.length, 2);
  assert.strictEqual(payload.messages[0].role, 'system');
  assert.strictEqual(payload.messages[0].content, 'You are a helpful coding assistant.');
  assert.strictEqual(payload.messages[1].role, 'user');
  assert.strictEqual(payload.messages[1].content, 'Hello!');
  console.log('✓ Test 1 Passed: System prompt and simple user message');
}

// Test 2: Tools conversion and cache_control stripping
{
  const input = {
    model: 'claude-3-5-sonnet-20241022',
    tools: [
      {
        name: 'Bash',
        description: 'Execute shell commands',
        cache_control: { type: 'ephemeral' },
        input_schema: {
          type: 'object',
          properties: {
            command: { type: 'string' }
          },
          required: ['command']
        }
      }
    ],
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Run ls -la', cache_control: { type: 'ephemeral' } }]
      }
    ]
  };

  const { payload } = transformAnthropicRequestToOpenAI(input);
  assert.strictEqual(payload.tools.length, 1);
  assert.strictEqual(payload.tools[0].type, 'function');
  assert.strictEqual(payload.tools[0].function.name, 'Bash');
  assert.strictEqual(payload.tools[0].function.parameters.type, 'object');
  assert.strictEqual(payload.tools[0].function.parameters.cache_control, undefined);
  assert.strictEqual(payload.messages[0].content, 'Run ls -la');
  console.log('✓ Test 2 Passed: Tools conversion and cache_control stripping');
}

// Test 3: Tool Use & Tool Result multi-turn conversion
{
  const input = {
    model: 'claude-3-5-sonnet-20241022',
    messages: [
      { role: 'user', content: 'What files are here?' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_use', id: 'toolu_123', name: 'Bash', input: { command: 'ls' } }
        ]
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_123', content: 'file1.txt\nfile2.txt' }
        ]
      }
    ]
  };

  const { payload } = transformAnthropicRequestToOpenAI(input);
  assert.strictEqual(payload.messages.length, 3);

  // Assistant message
  const assistantMsg = payload.messages[1];
  assert.strictEqual(assistantMsg.role, 'assistant');
  assert.strictEqual(assistantMsg.content, 'Let me check.');
  assert.strictEqual(assistantMsg.tool_calls.length, 1);
  assert.strictEqual(assistantMsg.tool_calls[0].id, 'toolu_123');
  assert.strictEqual(assistantMsg.tool_calls[0].function.name, 'Bash');
  assert.strictEqual(assistantMsg.tool_calls[0].function.arguments, '{"command":"ls"}');

  // Tool response message
  const toolMsg = payload.messages[2];
  assert.strictEqual(toolMsg.role, 'tool');
  assert.strictEqual(toolMsg.tool_call_id, 'toolu_123');
  assert.strictEqual(toolMsg.content, 'file1.txt\nfile2.txt');
  console.log('✓ Test 3 Passed: Tool Use & Tool Result multi-turn mapping');
}

// Test 4: OpenAI to Anthropic Non-streaming conversion
{
  const openAIData = {
    id: 'chatcmpl-987',
    choices: [
      {
        message: {
          role: 'assistant',
          content: 'Here is the output:',
          tool_calls: [
            {
              id: 'call_abc',
              type: 'function',
              function: {
                name: 'Bash',
                arguments: '{"command":"pwd"}'
              }
            }
          ]
        },
        finish_reason: 'tool_calls'
      }
    ],
    usage: { prompt_tokens: 25, completion_tokens: 15 }
  };

  const anthropicRes = transformOpenAIToAnthropicResponse(openAIData, 'claude-3-5-sonnet-20241022');
  assert.strictEqual(anthropicRes.type, 'message');
  assert.strictEqual(anthropicRes.role, 'assistant');
  assert.strictEqual(anthropicRes.content.length, 2);
  assert.strictEqual(anthropicRes.content[0].type, 'text');
  assert.strictEqual(anthropicRes.content[0].text, 'Here is the output:');
  assert.strictEqual(anthropicRes.content[1].type, 'tool_use');
  assert.strictEqual(anthropicRes.content[1].id, 'call_abc');
  assert.strictEqual(anthropicRes.content[1].name, 'Bash');
  assert.deepStrictEqual(anthropicRes.content[1].input, { command: 'pwd' });
  assert.strictEqual(anthropicRes.stop_reason, 'tool_use');
  assert.strictEqual(anthropicRes.usage.input_tokens, 25);
  assert.strictEqual(anthropicRes.usage.output_tokens, 15);
  console.log('✓ Test 4 Passed: OpenAI to Anthropic response transformation');
}

console.log('\nAll tests passed successfully! 🎉');

