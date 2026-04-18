export function buildPromptFromMessages(messages, toolPrompt) {
  const prefix = toolPrompt ? `SYSTEM: ${toolPrompt}\n\n` : "";
  return prefix + messages
    .map((message) => `${message.role.toUpperCase()}: ${message.content ?? ""}`)
    .join("\n\n");
}
