import { randomUUID } from "node:crypto";

const TOOL_CALL_PREFIX = "<tool_call";
const FUNCTION_CALL_PREFIX = "<function_call";
const CODE_BLOCK_RE = /```(?:tool_call|json)\s*\n?([\s\S]*?)```/g;
const JSON_OBJECT_RE = /\{[\s\n]*"name"\s*:\s*"[^"]+?"[\s\S]*?"arguments"\s*:\s*\{[\s\S]*?\}\s*\}/g;

const DEBUG = !!process.env.DEBUG_TOOL_CALL;

function debugLog(...args) {
  if (DEBUG) console.log("[tool-call]", ...args);
}

// --- JSON helpers ---

function parseJsonFrom(text, startIndex) {
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i];

    if (escape) { escape = false; continue; }
    if (ch === "\\" && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return { json: text.slice(startIndex, i + 1), endIndex: i + 1 };
      }
    }
  }

  // Attempt to auto-close truncated JSON
  if (depth > 0) {
    const closed = text.slice(startIndex) + "}".repeat(depth);
    try {
      JSON.parse(closed);
      debugLog("auto-closed truncated JSON, original depth:", depth);
      return { json: closed, endIndex: text.length };
    } catch {
      return null;
    }
  }

  return depth === 0 ? { json: text.slice(startIndex), endIndex: text.length } : null;
}

function makeToolCall(name, args) {
  return {
    id: `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    type: "function",
    function: {
      name,
      arguments: typeof args === "string" ? args : JSON.stringify(args ?? {})
    }
  };
}

// --- Parsing strategies (ordered by priority) ---

// Strategy 1: <tool_call={"name": "...", "arguments": {...}}>
function parseInlineFormat(text, markerIndex) {
  const eqIndex = markerIndex + TOOL_CALL_PREFIX.length;
  if (eqIndex >= text.length || text[eqIndex] !== "=") return null;

  const jsonResult = parseJsonFrom(text, eqIndex + 1);
  if (!jsonResult) return null;

  try {
    const parsed = JSON.parse(jsonResult.json);
    if (!parsed.name) return null;
    return { toolCalls: [makeToolCall(parsed.name, parsed.arguments)], endIndex: jsonResult.endIndex };
  } catch {
    return null;
  }
}

// Strategy 2: <tool_call name="...">{...}
function parseAttrFormat(text, markerIndex) {
  const afterPrefix = markerIndex + TOOL_CALL_PREFIX.length;
  const rest = text.slice(afterPrefix);

  const nameMatch = rest.match(/^\s+name\s*=\s*"([^"]+)"/);
  if (!nameMatch) return null;

  const afterAttr = afterPrefix + nameMatch[0].length;
  const gtIndex = text.indexOf(">", afterAttr);
  if (gtIndex === -1) return null;

  const jsonResult = parseJsonFrom(text, gtIndex + 1);
  if (!jsonResult) return null;

  try {
    const parsed = JSON.parse(jsonResult.json);
    return { toolCalls: [makeToolCall(nameMatch[1], parsed)], endIndex: jsonResult.endIndex };
  } catch {
    return null;
  }
}

// Strategy 3: <tool_call {"name": ...}> (loose: space instead of =)
function parseLooseInline(text, markerIndex) {
  const afterPrefix = markerIndex + TOOL_CALL_PREFIX.length;
  if (afterPrefix >= text.length || text[afterPrefix] !== " ") return null;

  const jsonStart = afterPrefix + 1;
  const jsonResult = parseJsonFrom(text, jsonStart);
  if (!jsonResult) return null;

  try {
    const parsed = JSON.parse(jsonResult.json);
    if (!parsed.name) return null;
    return { toolCalls: [makeToolCall(parsed.name, parsed.arguments)], endIndex: jsonResult.endIndex };
  } catch {
    return null;
  }
}

// Strategy 4: <function_call>{"name": "..."}</function_call> or <function_call name="...">...
function parseFunctionCallXml(text, markerIndex) {
  const afterPrefix = markerIndex + FUNCTION_CALL_PREFIX.length;
  const rest = text.slice(afterPrefix);

  // Try name attribute format: <function_call name="...">
  const nameMatch = rest.match(/^\s+name\s*=\s*"([^"]+)"/);
  if (nameMatch) {
    const afterAttr = afterPrefix + nameMatch[0].length;
    const gtIndex = text.indexOf(">", afterAttr);
    if (gtIndex !== -1) {
      const closeIndex = text.indexOf("</function_call>", gtIndex);
      const end = closeIndex !== -1 ? closeIndex + "</function_call>".length : text.length;
      const body = text.slice(gtIndex + 1, closeIndex !== -1 ? closeIndex : text.length).trim();
      try {
        const parsed = JSON.parse(body);
        return { toolCalls: [makeToolCall(nameMatch[1], parsed)], endIndex: end };
      } catch { /* fall through */ }
    }
  }

  // Try inline JSON format: <function_call>{"name": ...}</function_call>
  const gtIndex = text.indexOf(">", afterPrefix);
  if (gtIndex === -1) return null;

  const closeIndex = text.indexOf("</function_call>", gtIndex);
  const end = closeIndex !== -1 ? closeIndex + "</function_call>".length : text.length;
  const body = text.slice(gtIndex + 1, closeIndex !== -1 ? closeIndex : text.length).trim();

  try {
    const parsed = JSON.parse(body);
    if (parsed.name) {
      return { toolCalls: [makeToolCall(parsed.name, parsed.arguments)], endIndex: end };
    }
  } catch { /* ignore */ }

  return null;
}

// Strategy 5: ```tool_call or ```json code blocks
function parseCodeBlocks(text) {
  const toolCalls = [];
  let lastIndex = 0;

  CODE_BLOCK_RE.lastIndex = 0;
  let match;
  while ((match = CODE_BLOCK_RE.exec(text)) !== null) {
    const body = match[1].trim();
    try {
      const parsed = JSON.parse(body);
      if (parsed.name) {
        toolCalls.push(makeToolCall(parsed.name, parsed.arguments));
        lastIndex = match.index + match[0].length;
      }
    } catch { /* skip */ }
  }

  return toolCalls.length > 0 ? { toolCalls, endIndex: lastIndex } : null;
}

// Strategy 6: <tool_call name="..."><parameter name="...">value</parameter>...</tool_call >
// Also handles <function_call name="..."><parameter name="...">value</parameter></function_call>
function parseXmlParamFormat(text, markerIndex) {
  const afterPrefix = markerIndex === text.indexOf(TOOL_CALL_PREFIX, markerIndex)
    ? markerIndex + TOOL_CALL_PREFIX.length
    : markerIndex + FUNCTION_CALL_PREFIX.length;
  const rest = text.slice(afterPrefix);

  const nameMatch = rest.match(/^\s+name\s*=\s*"([^"]+)"/);
  if (!nameMatch) return null;

  const afterAttr = afterPrefix + nameMatch[0].length;
  const gtIndex = text.indexOf(">", afterAttr);
  if (gtIndex === -1) return null;

  // Detect closing tag based on marker type
  const isToolCall = text.slice(markerIndex).startsWith(TOOL_CALL_PREFIX);
  const closeTag = isToolCall ? "</tool_call" : "</function_call";
  const closeIndex = text.indexOf(closeTag, gtIndex + 1);
  const end = closeIndex !== -1 ? text.indexOf(">", closeIndex) + 1 : text.length;
  const body = text.slice(gtIndex + 1, closeIndex !== -1 ? closeIndex : text.length);

  // Try to extract <parameter> sub-tags
  const paramRe = /<parameter\s+name\s*=\s*"([^"]+)">([\s\S]*?)<\/parameter>/g;
  const args = {};
  let paramCount = 0;
  let m;
  while ((m = paramRe.exec(body)) !== null) {
    args[m[1]] = m[2].trim();
    paramCount++;
  }

  if (paramCount > 0) {
    return { toolCalls: [makeToolCall(nameMatch[1], args)], endIndex: end };
  }

  // Fallback: try parsing body as JSON (reuses existing attr behavior)
  const trimmed = body.trim();
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed);
      return { toolCalls: [makeToolCall(nameMatch[1], parsed)], endIndex: end };
    } catch { /* ignore */ }
  }

  // No arguments
  return { toolCalls: [makeToolCall(nameMatch[1], {})], endIndex: end };
}

// --- Marker-based strategies dispatcher ---

const MARKER_STRATEGIES = [
  { prefix: TOOL_CALL_PREFIX, parsers: [parseInlineFormat, parseAttrFormat, parseLooseInline, parseXmlParamFormat] },
  { prefix: FUNCTION_CALL_PREFIX, parsers: [parseFunctionCallXml, parseXmlParamFormat] },
];

// --- Main extraction ---

export function extractToolCalls(text) {
  if (!text) return null;

  // Try code block format first (independent of markers)
  const codeBlockResult = parseCodeBlocks(text);
  if (codeBlockResult) {
    debugLog("extracted via code block strategy:", codeBlockResult.toolCalls.length, "calls");
    return codeBlockResult.toolCalls;
  }

  // Try marker-based strategies
  const toolCalls = [];
  let searchStart = 0;

  while (searchStart < text.length) {
    let bestResult = null;
    let bestPos = text.length;

    // Find the nearest marker across all strategy prefixes
    for (const { prefix, parsers } of MARKER_STRATEGIES) {
      const idx = text.indexOf(prefix, searchStart);
      if (idx !== -1 && idx < bestPos) {
        for (const parser of parsers) {
          const result = parser(text, idx);
          if (result) {
            if (idx < bestPos) {
              bestPos = idx;
              bestResult = result;
            }
            break;
          }
        }
      }
    }

    if (!bestResult) break;
    toolCalls.push(...bestResult.toolCalls);
    searchStart = bestResult.endIndex;
  }

  // Last resort: try to find standalone JSON objects with "name" + "arguments"
  if (toolCalls.length === 0 && !text.includes(TOOL_CALL_PREFIX) && !text.includes(FUNCTION_CALL_PREFIX)) {
    JSON_OBJECT_RE.lastIndex = 0;
    let match;
    while ((match = JSON_OBJECT_RE.exec(text)) !== null) {
      try {
        const parsed = JSON.parse(match[0]);
        if (parsed.name && parsed.arguments) {
          toolCalls.push(makeToolCall(parsed.name, parsed.arguments));
        }
      } catch { /* skip */ }
    }
  }

  if (toolCalls.length > 0) {
    debugLog("extracted", toolCalls.length, "tool calls from", text.length, "chars");
  }
  return toolCalls.length > 0 ? toolCalls : null;
}

// --- Stream parser ---

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

      // Check for any known markers
      const markerIndex = findEarliestMarker(buffer);
      if (markerIndex !== -1) {
        decided = true;
        isToolCall = true;
        toolCallAccumulator = buffer.slice(markerIndex);

        const before = buffer.slice(0, markerIndex).trim();
        if (before) onText(before);
        return;
      }

      // Check for code block start
      const codeBlockMatch = buffer.match(/```(?:tool_call|json)\s*\n/);
      if (codeBlockMatch) {
        decided = true;
        isToolCall = true;
        toolCallAccumulator = buffer.slice(codeBlockMatch.index);
        const before = buffer.slice(0, codeBlockMatch.index).trim();
        if (before) onText(before);
        return;
      }

      // Heuristic: if buffer is long enough and doesn't start with a marker prefix, it's text
      const bufferTrimmed = buffer.trimStart();
      if (buffer.length > 60 && !bufferTrimmed.startsWith("<") && !bufferTrimmed.startsWith("`")) {
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

function findEarliestMarker(text) {
  let earliest = -1;
  for (const { prefix } of MARKER_STRATEGIES) {
    const idx = text.indexOf(prefix);
    if (idx !== -1 && (earliest === -1 || idx < earliest)) {
      earliest = idx;
    }
  }
  return earliest;
}

// --- Prompt generation ---

export function buildToolSystemPrompt(tools, toolChoice) {
  const toolNames = tools.map((tool) => tool.function?.name).filter(Boolean);
  const toolDescriptions = tools.map((tool) => {
    if (tool.type !== "function" || !tool.function) return null;
    const fn = tool.function;
    const params = formatParameters(fn.parameters);
    return `### ${fn.name}\nDescription: ${fn.description || "No description"}\nParameters:\n${params}`;
  }).filter(Boolean).join("\n\n");

  const nameList = toolNames.map((n) => `- ${n}`).join("\n");
  const exampleTool = toolNames[0] || "tool_name";
  const exampleArgs = tools[0]?.function?.parameters?.properties
    ? Object.keys(tools[0].function.parameters.properties).slice(0, 2)
    : ["param1"];

  const exampleArgsStr = exampleArgs.map(a => `"${a}": "value"`).join(", ");

  let instruction = `# Available Tools

You have access to the following tools. To call a tool, you MUST output EXACTLY this format on its own line:
<tool_call={"name": "EXACT_TOOL_NAME", "arguments": {"key": "value"}}>

CRITICAL RULES:
- You MUST ONLY call tools from the list below.
- You MUST use the EXACT tool name as shown (e.g. "${exampleTool}"), NOT abbreviated forms.
- Do NOT call any tool that is not listed, even if it was mentioned in previous conversation.
- Each tool call MUST be on its OWN separate line.
- Do NOT wrap tool calls in code blocks or any other formatting.
- Do NOT use XML-style parameter tags (e.g. <parameter name="...">).
- Do NOT output tool calls inside thinking or reasoning blocks. Tool calls MUST only appear in the final response.
- Tool descriptions contain ALL information needed to use them. Do NOT read files, documentation, or use other tools to "learn" or "figure out" how a tool works.
- When a user request clearly matches a tool's purpose, call that tool DIRECTLY. Do NOT use file-reading or exploratory tools as an intermediate step.

## Exact Tool Names

${nameList}

## Tool Details

${toolDescriptions}

## Correct Example

USER: Please use ${exampleTool} for me
ASSISTANT: <tool_call={"name": "${exampleTool}", "arguments": {${exampleArgsStr}}}>

## Incorrect Examples (DO NOT DO THIS)

BAD: <tool_call name="${exampleTool}"><parameter name="${exampleArgs[0]}">value</parameter></tool_call >
BAD: \`\`\`tool_call\n{"name": "${exampleTool}", "arguments": {${exampleArgsStr}}}\n\`\`\`
BAD: <function_call name="${exampleTool}">{"${exampleArgs[0]}": "value"}</function_call>`;

  if (toolChoice === "none") {
    return null;
  }

  if (toolChoice === "required") {
    instruction += "\n\nIMPORTANT: You MUST call at least one tool. Do not respond with plain text — output a tool call.";
  }

  if (typeof toolChoice === "object" && toolChoice?.function?.name) {
    instruction += `\n\nIMPORTANT: You MUST call the function "${toolChoice.function.name}". Do not respond with plain text — output the tool call.`;
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
