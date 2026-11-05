import { randomUUID } from 'node:crypto';

/**
 * Helper to write an SSE event according to Anthropic's specification
 */
function writeSSE(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Adapts an incoming OpenAI streaming SSE response into Anthropic Messages SSE events
 */
export async function streamOpenAIToAnthropic(openAIResponse, res, requestedModel) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('anthropic-version', '2023-06-01');

  const msgId = `msg_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

  // Send message_start
  writeSSE(res, 'message_start', {
    type: 'message_start',
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      content: [],
      model: requestedModel,
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0
      }
    }
  });

  let currentBlockIndex = 0;
  let textBlockStarted = false;
  let textBlockIndex = null;

  // Map to track OpenAI tool calls by index
  const toolBlocks = new Map();
  let finalFinishReason = null;
  let outputTokens = 0;

  // Read response stream line by line
  const reader = openAIResponse.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete trailing line

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith(':')) continue; // Ignore heartbeats/empty

        if (line.startsWith('data: ')) {
          const dataStr = line.slice(6).trim();

          if (dataStr === '[DONE]') {
            continue;
          }

          let chunk;
          try {
            chunk = JSON.parse(dataStr);
          } catch {
            // Incomplete or non-JSON chunk, skip
            continue;
          }

          const choice = chunk.choices?.[0];
          if (!choice) continue;

          if (choice.finish_reason) {
            finalFinishReason = choice.finish_reason;
          }

          const delta = choice.delta;
          if (!delta) continue;

          // 1. Text Delta
          if (delta.content) {
            outputTokens += Math.max(1, Math.ceil(delta.content.length / 4));

            if (!textBlockStarted) {
              textBlockIndex = currentBlockIndex++;
              writeSSE(res, 'content_block_start', {
                type: 'content_block_start',
                index: textBlockIndex,
                content_block: {
                  type: 'text',
                  text: ''
                }
              });
              textBlockStarted = true;
            }

            writeSSE(res, 'content_block_delta', {
              type: 'content_block_delta',
              index: textBlockIndex,
              delta: {
                type: 'text_delta',
                text: delta.content
              }
            });
          }

          // 2. Tool Calls Delta
          if (Array.isArray(delta.tool_calls)) {
            // If text block is active, close it before tool call block
            if (textBlockStarted) {
              writeSSE(res, 'content_block_stop', {
                type: 'content_block_stop',
                index: textBlockIndex
              });
              textBlockStarted = false;
            }

            for (const tc of delta.tool_calls) {
              const tcIndex = tc.index ?? 0;

              if (!toolBlocks.has(tcIndex)) {
                const anthropicIndex = currentBlockIndex++;
                const toolId = tc.id || `toolu_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
                const toolName = tc.function?.name || '';

                toolBlocks.set(tcIndex, {
                  anthropicIndex,
                  id: toolId,
                  name: toolName,
                  isClosed: false
                });

                writeSSE(res, 'content_block_start', {
                  type: 'content_block_start',
                  index: anthropicIndex,
                  content_block: {
                    type: 'tool_use',
                    id: toolId,
                    name: toolName,
                    input: {}
                  }
                });
              }

              const toolInfo = toolBlocks.get(tcIndex);

              if (tc.function?.arguments) {
                outputTokens += Math.max(1, Math.ceil(tc.function.arguments.length / 4));
                writeSSE(res, 'content_block_delta', {
                  type: 'content_block_delta',
                  index: toolInfo.anthropicIndex,
                  delta: {
                    type: 'input_json_delta',
                    partial_json: tc.function.arguments
                  }
                });
              }
            }
          }
        }
      }
    }

    // Close any unclosed text block
    if (textBlockStarted) {
      writeSSE(res, 'content_block_stop', {
        type: 'content_block_stop',
        index: textBlockIndex
      });
      textBlockStarted = false;
    }

    // Close all open tool blocks
    for (const toolInfo of toolBlocks.values()) {
      if (!toolInfo.isClosed) {
        writeSSE(res, 'content_block_stop', {
          type: 'content_block_stop',
          index: toolInfo.anthropicIndex
        });
        toolInfo.isClosed = true;
      }
    }

    // Determine stop reason
    let stopReason = 'end_turn';
    if (toolBlocks.size > 0 || finalFinishReason === 'tool_calls') {
      stopReason = 'tool_use';
    } else if (finalFinishReason === 'length') {
      stopReason = 'max_tokens';
    }

    // Send message_delta
    writeSSE(res, 'message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: stopReason,
        stop_sequence: null
      },
      usage: {
        output_tokens: outputTokens || 1
      }
    });

    // Send message_stop
    writeSSE(res, 'message_stop', {
      type: 'message_stop'
    });

    res.end();
  } catch (err) {
    console.error('Error during SSE stream translation:', err);
    if (!res.writableEnded) {
      res.end();
    }
  }
}

