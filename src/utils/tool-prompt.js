import { randomUUID } from "node:crypto";

const TOOL_CALL_PREFIX = "<tool_call";

export function buildToolSystemPrompt(tools, toolChoice) {
  const toolNames = tools.map((tool) => tool.function?.name).filter(Boolean);
  const toolDescriptions = tools.map((tool) => {
    if (tool.type !== "function" || !tool.function) return null;
    const fn = tool.function;
    const params = formatParameters(fn.parameters);
    return `### ${fn.name}\nDescription: ${fn.description || "No description"}\nParameters:\n${params}`;
  }).filter(Boolean).join("\n\n");

  const nameList = toolNames.map((n) => `- ${n}`).join("\n");

  let instruction = `# Available Tools\n\nYou have access to the following tools. To call a tool, output EXACTLY the following format on a new line:\n<tool_call={"name": "EXACT_TOOL_NAME", "arguments": {"key": "value"}}\nYou may call one or more tools by using multiple such lines. Do NOT output any other text on the same line as a tool call.\n\nCRITICAL:\n- You MUST ONLY call tools from the list below.\n- You MUST use the EXACT tool name as shown (e.g. "${toolNames[0] || "tool_name"}"), NOT abbreviated forms.\n- Do NOT call any tool that is not listed, even if it was mentioned in previous conversation.\n\n## Exact Tool Names\n\n${nameList}\n\n## Tool Details\n\n${toolDescriptions}`;

  if (toolChoice === "none") {
    return null;
  }

  if (toolChoice === "required") {
    instruction += "\n\nIMPORTANT: You MUST call at least one tool. Do not respond with plain text.";
  }

  if (typeof toolChoice === "object" && toolChoice?.function?.name) {
    instruction += `\n\nIMPORTANT: You MUST call the function "${toolChoice.function.name}". Do not respond with plain text.`;
  }

  instruction += "\n\nIf you do NOT need to call any tool, respond normally without any <tool_call markers.";

  return instruction;
}

function formatParameters(parameters) {
  if (!parameters?.properties) return "- (none)";

  const required = parameters.required ?? [];
  return Object.entries(parameters.properties).map(([name, schema]) => {
    const req = required.includes(name) ? "required" : "optional";
    const type = schema.type || "any";
    const desc = schema.description || "";
    return `- ${name} (${type}, ${req})${desc ? `: ${desc}` : ""}`;
  }).join("\n");
}

function parseJsonFrom(text, startIndex) {
  let depth = 0;
  let inString = false;
  let escape = false;
  let i = startIndex;

  for (; i < text.length; i++) {
    const ch = text[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return { json: text.slice(startIndex, i + 1), endIndex: i + 1 };
      }
    }
  }

  return depth === 0 ? { json: text.slice(startIndex), endIndex: text.length } : null;
}

function parseToolCallInline(text, markerIndex) {
  const eqIndex = markerIndex + TOOL_CALL_PREFIX.length;
  if (eqIndex >= text.length || text[eqIndex] !== "=") return null;

  const jsonStart = eqIndex + 1;
  const jsonResult = parseJsonFrom(text, jsonStart);
  if (!jsonResult) return null;

  try {
    const parsed = JSON.parse(jsonResult.json);
    if (!parsed.name) return null;
    return {
      toolCall: {
        id: `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
        type: "function",
        function: {
          name: parsed.name,
          arguments: typeof parsed.arguments === "string"
            ? parsed.arguments
            : JSON.stringify(parsed.arguments ?? {})
        }
      },
      endIndex: jsonResult.endIndex
    };
  } catch {
    return null;
  }
}

function parseToolCallAttr(text, markerIndex) {
  const afterPrefix = markerIndex + TOOL_CALL_PREFIX.length;
  const rest = text.slice(afterPrefix);

  const nameMatch = rest.match(/^\s+name\s*=\s*"([^"]+)"/);
  if (!nameMatch) return null;

  const afterAttr = afterPrefix + nameMatch[0].length;

  const gtIndex = text.indexOf(">", afterAttr);
  if (gtIndex === -1) return null;

  const jsonStart = gtIndex + 1;
  const jsonResult = parseJsonFrom(text, jsonStart);
  if (!jsonResult) return null;

  try {
    const parsed = JSON.parse(jsonResult.json);
    return {
      toolCall: {
        id: `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
        type: "function",
        function: {
          name: nameMatch[1],
          arguments: JSON.stringify(parsed)
        }
      },
      endIndex: jsonResult.endIndex
    };
  } catch {
    return null;
  }
}

export function extractToolCalls(text) {
  if (!text || !text.includes(TOOL_CALL_PREFIX)) return null;

  const toolCalls = [];
  let searchStart = 0;

  while (true) {
    const markerIndex = text.indexOf(TOOL_CALL_PREFIX, searchStart);
    if (markerIndex === -1) break;

    const result = parseToolCallInline(text, markerIndex) || parseToolCallAttr(text, markerIndex);
    if (result) {
      toolCalls.push(result.toolCall);
      searchStart = result.endIndex;
    } else {
      searchStart = markerIndex + TOOL_CALL_PREFIX.length;
    }
  }

  return toolCalls.length > 0 ? toolCalls : null;
}

export function createToolCallStreamParser(onToolCalls, onText) {
  let buffer = "";
  let decided = false;
  let isToolCall = false;
  let toolCallAccumulator = "";

  return {
    push(text) {
      if (!text) return;

      if (decided) {
        if (isToolCall) {
          toolCallAccumulator += text;
        } else {
          onText(text);
        }
        return;
      }

      buffer += text;

      const markerIndex = buffer.indexOf(TOOL_CALL_PREFIX);
      if (markerIndex !== -1) {
        decided = true;
        isToolCall = true;
        toolCallAccumulator = buffer.slice(markerIndex);

        const before = buffer.slice(0, markerIndex).trim();
        if (before) onText(before);
        return;
      }

      if (buffer.length > 40 && !buffer.startsWith("<")) {
        decided = true;
        isToolCall = false;
        onText(buffer);
        buffer = "";
        return;
      }
    },

    flush() {
      if (!decided && buffer) {
        decided = true;
        const toolCalls = extractToolCalls(buffer);
        if (toolCalls) {
          onToolCalls(toolCalls);
          return;
        }
        onText(buffer);
        buffer = "";
        return;
      }

      if (isToolCall && toolCallAccumulator) {
        const toolCalls = extractToolCalls(toolCallAccumulator);
        if (toolCalls) {
          onToolCalls(toolCalls);
        } else {
          onText(toolCallAccumulator);
        }
      }
    }
  };
}
