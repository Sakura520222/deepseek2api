import { randomUUID } from "node:crypto";

const TOOL_CALL_PREFIX = "<tool_call";
const TOOL_CALLS_PREFIX = "<tool_calls";
const TOOL_CODE_PREFIX = "<tool_code";
const INVOKE_PREFIX = "<invoke";
const FUNCTION_CALL_PREFIX = "<function_call";
const AGENT_CALL_PREFIX = "[调用 Agent]";
const CALLED_TOOL_PREFIX = "[Called tool:";
const PARAMETER_PREFIX = "<parameter";
const CODE_BLOCK_RE = /```(?:tool_call|json)\s*\n?([\s\S]*?)```/g;
const JSON_OBJECT_RE = /\{[\s\n]*"name"\s*:\s*"[^"]+?"[\s\S]*?"arguments"\s*:\s*\{[\s\S]*?\}\s*\}/g;

const DEBUG = !!process.env.DEBUG_TOOL_CALL;

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
  if (!jsonResult) {
    // Loose: <tool_call={"name": "Bash"> — incomplete JSON with just a name
    const looseMatch = text.slice(eqIndex + 1).match(/^\s*\{\s*"name"\s*:\s*"([^"]+)"\s*>/);
    if (looseMatch) {
      const gtEnd = text.indexOf(">", eqIndex);
      return { toolCalls: [makeToolCall(looseMatch[1], {})], endIndex: gtEnd !== -1 ? gtEnd + 1 : text.length };
    }
    return null;
  }

  try {
    const parsed = JSON.parse(jsonResult.json);
    if (!parsed.name) return null;
    return { toolCalls: [makeToolCall(parsed.name, parsed.arguments)], endIndex: jsonResult.endIndex };
  } catch {
    return null;
  }
}

// Loose extract for broken JSON with unescaped quotes in command values
// e.g. {"command": "pwsh -Command "echo hi"", "timeout": 15}
function extractLooseCommandArgs(text, jsonStart) {
  if (text[jsonStart] !== "{") return null;

  // Find "command": ... pattern
  const cmdMatch = text.slice(jsonStart).match(/^(\{[\s\n]*)("command")\s*:\s*/);
  if (!cmdMatch) return null;

  const prefixLen = cmdMatch[0].length;
  const cmdValStart = jsonStart + prefixLen;
  if (text[cmdValStart] !== '"') return null;

  // The command string has unescaped inner quotes. Use heuristic:
  // Find the next ", "timeout" or "}}" pattern after cmdValStart
  const delimRe = /",\s*"timeout"\s*:\s*\d+|"\s*\}\}/g;
  delimRe.lastIndex = cmdValStart + 1;
  const delimMatch = delimRe.exec(text);
  if (!delimMatch) return null;

  // The command value ends at the quote just before the delimiter
  // delimMatch.index points to the closing quote + comma/brace
  // Walk back from delimMatch.index to find the actual closing "
  let closeQuote = delimMatch.index;
  // delimMatch includes the leading ", so closeQuote points to "
  // The command value is between cmdValStart+1 and closeQuote
  const cmdVal = text.slice(cmdValStart + 1, closeQuote);

  // Extract timeout
  const timeoutMatch = text.slice(closeQuote).match(/"timeout"\s*:\s*(\d+)/);
  const timeout = timeoutMatch ? parseInt(timeoutMatch[1]) : undefined;

  // Find end of outer JSON object
  let braceEnd = text.indexOf("}}", jsonStart);
  if (braceEnd === -1) braceEnd = text.indexOf("}", closeQuote);
  const endIndex = braceEnd !== -1 ? braceEnd + 2 : text.length;

  const args = { command: cmdVal };
  if (timeout !== undefined) args.timeout = timeout;

  const toolName = cmdVal.trimStart().split(/\s+/)[0].replace(/\.exe$/i, "");
  const resolved = toolName.match(/^[\$\-@]/) ? "shell" : toolName;
  return { toolCalls: [makeToolCall(resolved, args)], endIndex };
}

// Strategy 2: <tool_call name="...">{...} or <tool_call name="arguments": {...}>
function parseAttrFormat(text, markerIndex) {
  const afterPrefix = markerIndex + TOOL_CALL_PREFIX.length;
  const rest = text.slice(afterPrefix);

  const nameMatch = rest.match(/^\s+name\s*=\s*"([^"]+)"/);
  if (!nameMatch) return null;

  const afterAttr = afterPrefix + nameMatch[0].length;
  const afterRest = text.slice(afterAttr);

  // Variant: <tool_call name="arguments": {"command": "...", "timeout": 15}}
  // No > separator, just colon + JSON
  const colonMatch = afterRest.match(/^\s*:\s*/);
  if (colonMatch) {
    const jsonStart = afterAttr + colonMatch[0].length;
    const jsonResult = parseJsonFrom(text, jsonStart);
    if (jsonResult) {
      try {
        const parsed = JSON.parse(jsonResult.json);
        const toolName = parsed.command
          ? parsed.command.trimStart().split(/\s+/)[0].replace(/\.exe$/i, "")
          : "shell";
        const resolved = toolName.match(/^[\$\-@]/) ? "shell" : toolName;
        return { toolCalls: [makeToolCall(resolved, parsed)], endIndex: jsonResult.endIndex };
      } catch { /* fall through to loose extract */ }
    }

    // Loose extract: strict JSON failed (e.g. unescaped quotes in command value)
    // Extract command value and timeout by pattern matching
    const looseResult = extractLooseCommandArgs(text, jsonStart);
    if (looseResult) return looseResult;
  }

  // Standard variant: <tool_call name="...">{...}
  const gtIndex = text.indexOf(">", afterAttr);
  if (gtIndex === -1) return null;

  const bodyStart = gtIndex + 1;

  // Try JSON body
  const jsonResult = parseJsonFrom(text, bodyStart);
  if (jsonResult) {
    try {
      const parsed = JSON.parse(jsonResult.json);
      return { toolCalls: [makeToolCall(nameMatch[1], parsed)], endIndex: jsonResult.endIndex };
    } catch { /* not JSON */ }
  }

  // Try extracting inner self-closing tags: <tool_call name="cmd" value="..." ... />
  const closeTag = "</tool_call";
  const closeIdx = text.indexOf(closeTag, bodyStart);
  const body = closeIdx !== -1 ? text.slice(bodyStart, closeIdx) : text.slice(bodyStart);
  const endGt = closeIdx !== -1 ? text.indexOf(">", closeIdx) + 1 : bodyStart + body.length;

  const selfCloseRe = /<tool_call\s+([\s\S]*?)\/>/g;
  const toolCalls = [];
  let m;
  while ((m = selfCloseRe.exec(body)) !== null) {
    const attrs = {};
    const attrRe = /(\w+)\s*=\s*"([^"]*)"/g;
    let am;
    while ((am = attrRe.exec(m[1])) !== null) attrs[am[1]] = am[2];
    if (Object.keys(attrs).length > 0) {
      const args = {};
      for (const [k, v] of Object.entries(attrs)) {
        if (k !== "name") args[k] = v;
      }
      toolCalls.push(makeToolCall(nameMatch[1], args));
    }
  }

  if (toolCalls.length > 0) return { toolCalls, endIndex: endGt };

  return null;
}

// Strategy 3: <tool_call name="..." arguments={...}>  (Codex inline-attr format)
function parseInlineAttrFormat(text, markerIndex) {
  const afterPrefix = markerIndex + TOOL_CALL_PREFIX.length;
  const rest = text.slice(afterPrefix);

  const attrMatch = rest.match(/^\s+name\s*=\s*"([^"]+)"\s+arguments\s*=\s*/);
  if (!attrMatch) return null;

  const jsonStart = afterPrefix + attrMatch[0].length;
  const jsonResult = parseJsonFrom(text, jsonStart);
  if (!jsonResult) return null;

  const afterJson = text.slice(jsonResult.endIndex).trimStart();
  if (afterJson.length > 0 && afterJson[0] !== ">") return null;

  try {
    const parsed = JSON.parse(jsonResult.json);
    return { toolCalls: [makeToolCall(attrMatch[1], parsed)], endIndex: jsonResult.endIndex };
  } catch { return null; }
}

// Strategy 4: <tool_call JSON> (loose: whitespace then JSON)
function parseLooseInline(text, markerIndex) {
  const afterPrefix = markerIndex + TOOL_CALL_PREFIX.length;
  const rest = text.slice(afterPrefix);

  const wsMatch = rest.match(/^\s+/);
  if (!wsMatch) return null;

  const jsonStart = afterPrefix + wsMatch[0].length;
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

// Strategy: [调用 Agent] {"description":"...", "subagent_type":"...", "prompt":"..."}
function parseAgentCallFormat(text, markerIndex) {
  const afterPrefix = markerIndex + AGENT_CALL_PREFIX.length;
  const rest = text.slice(afterPrefix);

  const jsonStartMatch = rest.match(/^\s*/);
  const jsonStart = afterPrefix + jsonStartMatch[0].length;

  const jsonResult = parseJsonFrom(text, jsonStart);
  if (!jsonResult) return null;

  try {
    const parsed = JSON.parse(jsonResult.json);
    const name = parsed.description || parsed.subagent_type || "agent";
    const { description, ...args } = parsed;
    return { toolCalls: [makeToolCall(name, args)], endIndex: jsonResult.endIndex };
  } catch { return null; }
}

// Strategy: <tool_call="name">...<tool_call attr="..." />...</tool_call="name">
// Handles Codex's nested wrapper format with equals-value opening tag
function parseToolCallWrapper(text, markerIndex) {
  const afterPrefix = markerIndex + TOOL_CALL_PREFIX.length;
  const rest = text.slice(afterPrefix);

  // Must be <tool_call="name">
  const nameMatch = rest.match(/^="([^"]+)">\s*/);
  if (!nameMatch) return null;

  const toolName = nameMatch[1];
  const contentStart = afterPrefix + nameMatch[0].length;

  // Collect content up to the outer closing tag
  const toolCalls = [];
  let searchPos = contentStart;

  // Find the outer closing boundary — skip inner closing tags
  // Count nested <tool_calls> openings and match with closings
  let outerEnd = text.length;
  let depth = 0;
  for (let i = contentStart; i < text.length; i++) {
    if (text.startsWith("<tool_calls", i) && !text.startsWith("</tool_calls", i)) {
      // Check it's an opening tag (not self-closing)
      const afterGt = text.indexOf(">", i + TOOL_CALLS_PREFIX.length);
      if (afterGt !== -1 && text[afterGt - 1] !== "/") {
        depth++;
      }
    } else if (text.startsWith("</tool_calls", i)) {
      if (depth > 0) {
        depth--;
      } else {
        // This is the closing tag for our wrapper — but we look for </tool_call
        // Actually </tool_calls> might close an inner wrapper; skip if depth > 0
      }
    } else if (text.startsWith("</tool_call", i) && !text.startsWith("</tool_calls", i)) {
      // </tool_call...> could be our closing tag
      const gt = text.indexOf(">", i);
      outerEnd = gt !== -1 ? gt + 1 : i;
      break;
    }
  }

  const content = text.slice(contentStart, outerEnd);

  // Extract all self-closing <tool_call ... /> from the content
  // These inherit the wrapper's tool name
  const selfCloseRe = /<tool_call\s+([\s\S]*?)\/>/g;
  let m;
  while ((m = selfCloseRe.exec(content)) !== null) {
    const attrText = m[1];
    const attrs = {};
    const attrRe = /(\w+)\s*=\s*"([^"]*)"/g;
    let am;
    while ((am = attrRe.exec(attrText)) !== null) {
      attrs[am[1]] = am[2];
    }
    if (Object.keys(attrs).length === 0) continue;

    // Use wrapper name as tool name; self-closing tags are parameters of the wrapper tool
    const name = attrs.name || toolName;
    const args = {};
    for (const [k, v] of Object.entries(attrs)) {
      if (k !== "name") args[k] = v;
    }
    toolCalls.push(makeToolCall(name, args));
  }

  if (toolCalls.length === 0) {
    toolCalls.push(makeToolCall(toolName, {}));
  }

  return { toolCalls, endIndex: outerEnd };
}

// Strategy: <tool_call command="..." justification="..." />
// Handles Codex's self-closing attribute format
function parseSelfClosingAttr(text, markerIndex) {
  const afterPrefix = markerIndex + TOOL_CALL_PREFIX.length;
  const rest = text.slice(afterPrefix);

  // Must have whitespace then attributes (not = or >)
  const wsMatch = rest.match(/^\s+/);
  if (!wsMatch) return null;

  const attrText = rest.slice(wsMatch[0].length);

  // Check for self-closing />
  // Extract all attributes: name="value" or just bare attributes
  const attrs = {};
  const attrRe = /(\w+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = attrRe.exec(attrText)) !== null) {
    attrs[m[1]] = m[2];
  }

  if (Object.keys(attrs).length === 0) return null;

  // Find the self-closing />
  const closeIdx = attrText.indexOf("/>");
  if (closeIdx === -1) return null;

  // Reject if there's a > before /> (means this is an opening tag, not self-closing)
  const gtBeforeClose = attrText.indexOf(">");
  if (gtBeforeClose !== -1 && gtBeforeClose < closeIdx) return null;

  // Determine tool name - prefer "name" attr, fall back to first attr or "shell"
  const name = attrs.name || Object.keys(attrs)[0] || "shell";

  // Build arguments from remaining attributes (exclude 'name')
  const args = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (k !== "name") args[k] = v;
  }

  const endIndex = markerIndex + TOOL_CALL_PREFIX.length + wsMatch[0].length + closeIdx + 2;
  return { toolCalls: [makeToolCall(name, args)], endIndex };
}

// Strategy: <tool_calls>...inner content...</tool_calls>
// Strips the outer <tool_calls> wrapper and delegates to inner strategies
function parseToolCallsWrapper(text, markerIndex) {
  const afterPrefix = markerIndex + TOOL_CALLS_PREFIX.length;
  const rest = text.slice(afterPrefix);

  // Must be <tool_calls> (with optional whitespace before >)
  const gtMatch = rest.match(/^\s*>/);
  if (!gtMatch) return null;

  const contentStart = afterPrefix + gtMatch[0].length;

  // Find matching </tool_calls> with depth tracking
  let depth = 1;
  let pos = contentStart;
  let closeEnd = -1;

  while (pos < text.length && depth > 0) {
    const nextOpen = text.indexOf("<tool_calls", pos);
    const nextClose = text.indexOf("</tool_calls", pos);

    if (nextClose === -1) break;

    if (nextOpen !== -1 && nextOpen < nextClose) {
      // Check it's a real opening tag (has > after attributes, not />)
      const afterOpen = text.slice(nextOpen + TOOL_CALLS_PREFIX.length);
      const openGt = afterOpen.indexOf(">");
      if (openGt !== -1 && afterOpen[openGt - 1] !== "/") {
        depth++;
      }
      pos = nextOpen + TOOL_CALLS_PREFIX.length + 1;
      continue;
    }

    depth--;
    if (depth === 0) {
      const content = text.slice(contentStart, nextClose);
      const gt = text.indexOf(">", nextClose);
      closeEnd = gt !== -1 ? gt + 1 : nextClose + "</tool_calls>".length;

      const innerCalls = extractToolCalls(content);
      if (innerCalls && innerCalls.length > 0) {
        return { toolCalls: innerCalls, endIndex: closeEnd };
      }
    }
    pos = nextClose + 1;
  }

  // No closing tag found — extract from remaining content
  const content = text.slice(contentStart);
  const innerCalls = extractToolCalls(content);
  if (innerCalls && innerCalls.length > 0) {
    return { toolCalls: innerCalls, endIndex: text.length };
  }

  return null;
}

// Strategy: <invoke><parameter name="url">...</parameter>...</invoke>
function parseInvokeWrapper(text, markerIndex) {
  const afterPrefix = markerIndex + INVOKE_PREFIX.length;
  const rest = text.slice(afterPrefix);

  // Must be <invoke> or <invoke name="...">
  const gtMatch = rest.match(/^\s*>/);
  const attrMatch = rest.match(/^\s+[^>]*>/);

  let contentStart, attrText;
  if (gtMatch) {
    contentStart = afterPrefix + gtMatch[0].length;
    attrText = "";
  } else if (attrMatch) {
    contentStart = afterPrefix + attrMatch[0].length;
    attrText = attrMatch[0];
  } else {
    return null;
  }

  // Extract tool name from invoke attribute if present
  const invokeAttrTool = attrText.match(/name\s*=\s*"([^"]+)"/);
  const closeTag = "</invoke>";
  const closeIdx = text.indexOf(closeTag, contentStart);
  if (closeIdx === -1) return null;

  const content = text.slice(contentStart, closeIdx);

  // Try inner JSON first: <invoke>{"name": "...", "arguments": {...}}</invoke>
  const trimmed = content.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.name) {
        return { toolCalls: [makeToolCall(parsed.name, parsed.arguments)], endIndex: closeIdx + closeTag.length };
      }
    } catch { /* not valid JSON, try parameter extraction */ }
  }

  // Try inner tool call extraction (for nested <tool_call...> etc.)
  const innerCalls = extractToolCalls(content);
  if (innerCalls && innerCalls.length > 0) {
    return { toolCalls: innerCalls, endIndex: closeIdx + closeTag.length };
  }

  // Extract <parameter name="...">value</parameter>
  const paramRe = /<parameter\s+name\s*=\s*"([^"]+)">([\s\S]*?)<\/parameter>/g;
  const args = {};
  let m;
  while ((m = paramRe.exec(content)) !== null) {
    args[m[1]] = m[2].trim();
  }

  if (Object.keys(args).length === 0) {
    // Try <tool_call_name>name</tool_call_name> + <tool_call_args>{...}</tool_call_args>
    const nameMatch = content.match(/<tool_call_name>([\s\S]*?)<\/tool_call_name>/);
    const argsMatch = content.match(/<tool_call_args>([\s\S]*?)<\/tool_call_args>/);
    if (nameMatch) {
      const toolName = nameMatch[1].trim();
      let toolArgs = {};
      if (argsMatch) {
        try { toolArgs = JSON.parse(argsMatch[1].trim()); } catch { toolArgs = { raw: argsMatch[1].trim() }; }
      }
      return { toolCalls: [makeToolCall(toolName, toolArgs)], endIndex: closeIdx + closeTag.length };
    }
    return null;
  }

  // Determine tool name: from invoke attribute, or infer from parameters
  const toolName = invokeAttrTool
    ? invokeAttrTool[1]
    : inferToolName(args);

  return { toolCalls: [makeToolCall(toolName, args)], endIndex: closeIdx + closeTag.length };
}

// Infer tool name from parameter names
function inferToolName(args) {
  if (args.url || args.uri || args.href) return "web_fetch";
  if (args.command || args.cmd) return "shell";
  if (args.query && (args.count || args.maxResults)) return "web_search";
  if (args.path && args.content) return "write";
  if (args.path && !args.content) return "read";
  return "tool";
}

// Strategy: [Called tool: name] {...}
function parseCalledToolFormat(text, markerIndex) {
  const afterPrefix = markerIndex + CALLED_TOOL_PREFIX.length;
  const rest = text.slice(afterPrefix);

  // Extract tool name until ]
  const bracketClose = rest.indexOf("]");
  if (bracketClose === -1) return null;

  const toolName = rest.slice(0, bracketClose).trim();
  if (!toolName) return null;

  // Find JSON after ]
  const afterBracket = afterPrefix + bracketClose + 1;
  const jsonResult = parseJsonFrom(text, text.indexOf("{", afterBracket));
  if (!jsonResult) return null;

  try {
    const parsed = JSON.parse(jsonResult.json);
    return { toolCalls: [makeToolCall(toolName, parsed)], endIndex: jsonResult.endIndex };
  } catch {
    return null;
  }
}

// Strategy: <tool_code>{"command": "...", "timeout": N}</tool_code>
function parseToolCodeWrapper(text, markerIndex) {
  const afterPrefix = markerIndex + TOOL_CODE_PREFIX.length;
  const rest = text.slice(afterPrefix);

  const gtMatch = rest.match(/^\s*>/);
  if (!gtMatch) return null;

  const contentStart = afterPrefix + gtMatch[0].length;
  const closeTag = "</tool_code>";
  const closeIdx = text.indexOf(closeTag, contentStart);
  if (closeIdx === -1) return null;

  const body = text.slice(contentStart, closeIdx).trim();

  // Try JSON with command field → shell tool
  try {
    const parsed = JSON.parse(body);
    if (parsed.command) {
      const toolName = parsed.command.trimStart().split(/\s+/)[0].replace(/\.exe$/i, "");
      const resolved = toolName.match(/^[\$\-@]/) ? "shell" : toolName;
      return { toolCalls: [makeToolCall(resolved, parsed)], endIndex: closeIdx + closeTag.length };
    }
    if (parsed.name) {
      return { toolCalls: [makeToolCall(parsed.name, parsed.arguments)], endIndex: closeIdx + closeTag.length };
    }
  } catch { /* not JSON */ }

  // Try delegating to extractToolCalls for inner content
  const innerCalls = extractToolCalls(body);
  if (innerCalls && innerCalls.length > 0) {
    return { toolCalls: innerCalls, endIndex: closeIdx + closeTag.length };
  }

  return null;
}

// Strategy: <parameter name="query" tool="web_search">value</parameter>
// OpenClaw format: multiple <parameter> tags with tool/tool_name attr aggregate into one call
function parseParameterTags(text, markerIndex) {
  const closeTag = "</parameter>";

  // Parse a single <parameter> tag starting at pos, return {attrs, value, endIndex} or null
  function parseOneParam(pos) {
    if (!text.startsWith("<parameter", pos)) return null;
    const after = pos + PARAMETER_PREFIX.length;
    const rest = text.slice(after);

    const wsMatch = rest.match(/^\s+/);
    if (!wsMatch) return null;

    const openGt = rest.indexOf(">");
    if (openGt === -1) return null;

    const attrText = rest.slice(wsMatch[0].length, openGt);
    const attrs = {};
    const attrRe = /(\w+)\s*=\s*"([^"]*)"/g;
    let m;
    while ((m = attrRe.exec(attrText)) !== null) {
      attrs[m[1]] = m[2];
    }

    const valueStart = after + openGt + 1;
    const closeIdx = text.indexOf(closeTag, valueStart);
    if (closeIdx === -1) return null;

    const value = text.slice(valueStart, closeIdx).trim();
    return { attrs, value, endIndex: closeIdx + closeTag.length };
  }

  // Parse the first parameter
  const first = parseOneParam(markerIndex);
  if (!first) return null;

  const toolName = first.attrs.tool || first.attrs.tool_name;

  const args = { [first.attrs.name || "input"]: first.value };
  let scanPos = first.endIndex;

  // Aggregate consecutive <parameter> tags
  // Only aggregate if they are separated by single newlines (no blank lines between)
  while (scanPos < text.length) {
    let gapStart = scanPos;
    while (scanPos < text.length && /\s/.test(text[scanPos])) scanPos++;

    const gap = text.slice(gapStart, scanPos);
    if (gap.includes("\n\n") || gap.includes("\r\n\r\n")) break;

    const next = parseOneParam(scanPos);
    if (!next) break;

    // If both have tool attrs, they must match; otherwise keep aggregating
    if (toolName) {
      const nextTool = next.attrs.tool || next.attrs.tool_name;
      if (nextTool && nextTool !== toolName) break;
    }

    const nextName = next.attrs.name || "input";
    args[nextName] = next.value;
    scanPos = next.endIndex;
  }

  // Resolve tool name: explicit attr > inferred from args
  const resolved = toolName || inferToolName(args);
  if (!resolved) return null;

  return { toolCalls: [makeToolCall(resolved, args)], endIndex: scanPos };
}

// --- Marker-based strategies dispatcher ---

const MARKER_STRATEGIES = [
  { prefix: TOOL_CALL_PREFIX, parsers: [parseToolCallWrapper, parseSelfClosingAttr, parseInlineFormat, parseAttrFormat, parseInlineAttrFormat, parseLooseInline, parseXmlParamFormat] },
  { prefix: TOOL_CALLS_PREFIX, parsers: [parseToolCallsWrapper] },
  { prefix: TOOL_CODE_PREFIX, parsers: [parseToolCodeWrapper] },
  { prefix: INVOKE_PREFIX, parsers: [parseInvokeWrapper] },
  { prefix: FUNCTION_CALL_PREFIX, parsers: [parseFunctionCallXml, parseXmlParamFormat] },
  { prefix: PARAMETER_PREFIX, parsers: [parseParameterTags] },
  { prefix: CALLED_TOOL_PREFIX, parsers: [parseCalledToolFormat] },
  { prefix: AGENT_CALL_PREFIX, parsers: [parseAgentCallFormat] },
];

// --- Main extraction ---

export function extractToolCalls(text, debugCtx = null) {
  if (!text) return null;

  const strategies = [];

  // Try code block format first (independent of markers)
  const codeBlockResult = parseCodeBlocks(text);
  if (codeBlockResult) {
    debugCtx?.logToolParsing({
      inputLength: text.length,
      strategiesTried: ["parseCodeBlocks"],
      successStrategy: "parseCodeBlocks",
      rawResultCount: codeBlockResult.toolCalls.length,
      rawResults: codeBlockResult.toolCalls.map(tc => ({ name: tc.function.name }))
    });
    return codeBlockResult.toolCalls;
  }

  // Try marker-based strategies
  const toolCalls = [];
  let searchStart = 0;

  while (searchStart < text.length) {
    let bestResult = null;
    let bestPos = text.length;
    let matchedStrategy = null;

    for (const { prefix, parsers } of MARKER_STRATEGIES) {
      const idx = text.indexOf(prefix, searchStart);
      if (idx !== -1 && idx < bestPos) {
        for (const parser of parsers) {
          const parserName = parser.name;
          strategies.push(parserName);
          const result = parser(text, idx);
          if (result) {
            if (idx < bestPos) {
              bestPos = idx;
              bestResult = result;
              matchedStrategy = `${prefix}:${parserName}`;
            }
            break;
          }
        }
      }
    }

    if (!bestResult) break;
    toolCalls.push(...bestResult.toolCalls);
    searchStart = bestResult.endIndex;
    debugCtx?.logToolParsing({
      inputLength: text.length,
      strategiesTried: strategies.slice(-10),
      successStrategy: matchedStrategy,
      rawResultCount: toolCalls.length,
      rawResults: toolCalls.map(tc => ({ name: tc.function.name, argLength: tc.function.arguments.length }))
    });
  }

  // Last resort: try to find standalone JSON objects with "name" + "arguments"
  if (toolCalls.length === 0 && !text.includes(TOOL_CALL_PREFIX) && !text.includes(FUNCTION_CALL_PREFIX) && !text.includes(TOOL_CODE_PREFIX) && !text.includes(INVOKE_PREFIX) && !text.includes(PARAMETER_PREFIX) && !text.includes(CALLED_TOOL_PREFIX) && !text.includes(AGENT_CALL_PREFIX)) {
    strategies.push("standaloneJSON");
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

  debugCtx?.logToolParsing({
    inputLength: text.length,
    strategiesTried: strategies.length > 0 ? [...new Set(strategies)] : ["none"],
    successStrategy: toolCalls.length > 0 ? strategies[strategies.length - 1] : null,
    rawResultCount: toolCalls.length,
    rawResults: toolCalls.map(tc => ({ name: tc.function.name, argLength: tc.function.arguments.length }))
  });

  return toolCalls.length > 0 ? toolCalls : null;
}

// --- Stream parser ---

export function createToolCallStreamParser(onToolCalls, onText) {
  let buffer = "";
  let decided = false;
  let isToolCall = false;
  let toolCallAccumulator = "";
  let textAccumulator = "";

  // Marker prefixes that can appear mid-text
  const MID_TEXT_MARKERS = [TOOL_CALL_PREFIX, TOOL_CALLS_PREFIX, TOOL_CODE_PREFIX, INVOKE_PREFIX, FUNCTION_CALL_PREFIX, PARAMETER_PREFIX, CALLED_TOOL_PREFIX, AGENT_CALL_PREFIX];

  return {
    push(text) {
      if (!text) return;

      if (decided) {
        if (isToolCall) {
          toolCallAccumulator += text;
        } else {
          // Even after deciding text, check for markers mid-stream
          textAccumulator += text;
          for (const prefix of MID_TEXT_MARKERS) {
            const idx = textAccumulator.lastIndexOf(prefix);
            if (idx !== -1) {
              // Output text before marker, then switch to tool call
              const before = textAccumulator.slice(0, idx);
              if (before) onText(before);
              decided = true;
              isToolCall = true;
              toolCallAccumulator = textAccumulator.slice(idx);
              textAccumulator = "";
              return;
            }
          }
          // Check for bare JSON
          const jsonMatch = textAccumulator.match(/\n\s*\{"name"/);
          if (jsonMatch) {
            const idx = textAccumulator.indexOf(jsonMatch[0]);
            const before = textAccumulator.slice(0, idx);
            if (before) onText(before);
            decided = true;
            isToolCall = true;
            toolCallAccumulator = textAccumulator.slice(idx).trimStart();
            textAccumulator = "";
            return;
          }
          // No marker — flush accumulated text periodically
          if (textAccumulator.length > 200) {
            onText(textAccumulator);
            textAccumulator = "";
          }
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

      // Check for bare JSON starting with {"name":
      const bufferTrimmed = buffer.trimStart();
      if (bufferTrimmed.startsWith('{"name"')) {
        if (bufferTrimmed.length > 20) {
          const testCalls = extractToolCalls(bufferTrimmed);
          if (testCalls) {
            if (!bufferTrimmed.includes("}")) return;
            decided = true;
            isToolCall = true;
            toolCallAccumulator = bufferTrimmed;
            const leadingWs = buffer.length - bufferTrimmed.length;
            const before = buffer.slice(0, leadingWs).trim();
            if (before) onText(before);
            return;
          }
        }
        if (bufferTrimmed.length <= 60) return;
      }

      // Heuristic: if buffer is long enough and doesn't contain any marker, start as text
      if (buffer.length > 60) {
        const startsLikeMarker = bufferTrimmed.startsWith("<") || bufferTrimmed.startsWith("`") || bufferTrimmed.startsWith("{");
        if (startsLikeMarker) return;

        decided = true;
        isToolCall = false;
        textAccumulator = buffer;
        buffer = "";
        // Don't flush yet — keep in textAccumulator for mid-text marker detection
        return;
      }
    },

    flush() {
      // Flush any accumulated text
      if (textAccumulator) {
        onText(textAccumulator);
        textAccumulator = "";
      }

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
