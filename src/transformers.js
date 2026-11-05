import { resolveModel } from './config.js';
import { randomUUID } from 'node:crypto';

/**
 * Strips Anthropic-specific fields like cache_control from JSON schemas or objects
 */
function cleanSchema(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(cleanSchema);

  const cleaned = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'cache_control') continue;
    cleaned[key] = cleanSchema(value);
  }
  return cleaned;
}

/**
 * Transforms an Anthropic Messages API request payload into OpenAI Chat Completions payload
 */
export function transformAnthropicRequestToOpenAI(body) {
  const openAIMessages = [];

  // 1. Handle system prompt
  if (body.system) {
    let systemText = '';
    if (typeof body.system === 'string') {
      systemText = body.system;
    } else if (Array.isArray(body.system)) {
      systemText = body.system
        .map(b => (typeof b === 'string' ? b : b.text || ''))
        .filter(Boolean)
        .join('\n\n');
    }

    if (systemText) {
      openAIMessages.push({
        role: 'system',
        content: systemText
      });
    }
  }

  // 2. Handle messages
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      const role = msg.role;

      if (typeof msg.content === 'string') {
        openAIMessages.push({
          role,
          content: msg.content
        });
        continue;
      }

      if (Array.isArray(msg.content)) {
        // Collect blocks by type
        const textParts = [];
        const toolCalls = [];
        const toolResults = [];

        for (const block of msg.content) {
          if (block.type === 'text') {
            if (block.text) textParts.push(block.text);
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id || `call_${randomUUID().replace(/-/g, '').slice(0, 9)}`,
              type: 'function',
              function: {
                name: block.name,
                arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input || {})
              }
            });
          } else if (block.type === 'tool_result') {
            let resContent = '';
            if (typeof block.content === 'string') {
              resContent = block.content;
            } else if (Array.isArray(block.content)) {
              resContent = block.content
                .map(c => (typeof c === 'string' ? c : c.text || JSON.stringify(c)))
                .join('\n');
            } else if (block.content !== undefined && block.content !== null) {
              resContent = JSON.stringify(block.content);
            }

            toolResults.push({
              role: 'tool',
              tool_call_id: block.tool_use_id,
              content: resContent || '(empty result)'
            });
          }
        }

        if (role === 'assistant') {
          const assistantMsg = {
            role: 'assistant',
            content: textParts.join('\n\n') || (toolCalls.length > 0 ? null : '')
          };
          if (toolCalls.length > 0) {
            assistantMsg.tool_calls = toolCalls;
          }
          openAIMessages.push(assistantMsg);
        } else if (role === 'user') {
          // If there are tool results, they MUST precede or be individual tool messages
          for (const tr of toolResults) {
            openAIMessages.push(tr);
          }
          if (textParts.length > 0) {
            openAIMessages.push({
              role: 'user',
              content: textParts.join('\n\n')
            });
          }
        }
      }
    }
  }

  // 3. Handle tools
  let openAITools = undefined;
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    openAITools = body.tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: cleanSchema(tool.input_schema || {})
      }
    }));
  }

  // 4. Map model
  const targetModel = resolveModel(body.model);

  // 5. Constrain max_tokens to safe threshold for NVIDIA NIM
  let maxTokens = body.max_tokens;
  if (!maxTokens || maxTokens > 4096) {
    maxTokens = 4096;
  }

  const payload = {
    model: targetModel,
    messages: openAIMessages,
    stream: Boolean(body.stream),
    max_tokens: maxTokens
  };

  if (typeof body.temperature === 'number') {
    payload.temperature = body.temperature;
  }
  if (openAITools) {
    payload.tools = openAITools;
  }

  return {
    targetModel,
    payload
  };
}

/**
 * Transforms an OpenAI Non-Streaming Response to Anthropic Messages response format
 */
export function transformOpenAIToAnthropicResponse(openaiData, requestedModel) {
  const choice = openaiData.choices?.[0] || {};
  const message = choice.message || {};
  const content = [];

  if (message.content) {
    content.push({
      type: 'text',
      text: message.content
    });
  }

  if (Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      let parsedArgs = {};
      try {
        parsedArgs = JSON.parse(tc.function.arguments || '{}');
      } catch {
        parsedArgs = { raw: tc.function.arguments };
      }

      content.push({
        type: 'tool_use',
        id: tc.id || `toolu_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
        name: tc.function.name,
        input: parsedArgs
      });
    }
  }

  let stopReason = 'end_turn';
  if (choice.finish_reason === 'tool_calls') {
    stopReason = 'tool_use';
  } else if (choice.finish_reason === 'length') {
    stopReason = 'max_tokens';
  } else if (choice.finish_reason === 'stop') {
    stopReason = 'end_turn';
  }

  return {
    id: `msg_${(openaiData.id || randomUUID()).replace(/[^a-zA-Z0-9_-]/g, '')}`,
    type: 'message',
    role: 'assistant',
    content: content.length > 0 ? content : [{ type: 'text', text: '' }],
    model: requestedModel,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: openaiData.usage?.prompt_tokens || 0,
      output_tokens: openaiData.usage?.completion_tokens || 0
    }
  };
}

