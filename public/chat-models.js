const CHAT_MODELS = Object.freeze([
  Object.freeze({ id: "deepseek-chat-fast", modelType: "default", searchEnabled: false, thinkingEnabled: false }),
  Object.freeze({ id: "deepseek-chat-fast-search", modelType: "default", searchEnabled: true, thinkingEnabled: false }),
  Object.freeze({ id: "deepseek-reasoner-fast", modelType: "default", searchEnabled: false, thinkingEnabled: true }),
  Object.freeze({ id: "deepseek-reasoner-fast-search", modelType: "default", searchEnabled: true, thinkingEnabled: true }),
  Object.freeze({ id: "deepseek-chat-expert", modelType: "expert", searchEnabled: false, thinkingEnabled: false }),
  Object.freeze({ id: "deepseek-chat-expert-search", modelType: "expert", searchEnabled: true, thinkingEnabled: false }),
  Object.freeze({ id: "deepseek-reasoner-expert", modelType: "expert", searchEnabled: false, thinkingEnabled: true }),
  Object.freeze({ id: "deepseek-reasoner-expert-search", modelType: "expert", searchEnabled: true, thinkingEnabled: true }),
  Object.freeze({ id: "deepseek-v4-flash", modelType: "default", searchEnabled: false, thinkingEnabled: false }),
  Object.freeze({ id: "deepseek-v4-flash-search", modelType: "default", searchEnabled: true, thinkingEnabled: false }),
  Object.freeze({ id: "deepseek-v4-reasoner-flash", modelType: "default", searchEnabled: false, thinkingEnabled: true }),
  Object.freeze({ id: "deepseek-v4-reasoner-flash-search", modelType: "default", searchEnabled: true, thinkingEnabled: true }),
  Object.freeze({ id: "deepseek-v4-pro", modelType: "expert", searchEnabled: false, thinkingEnabled: false }),
  Object.freeze({ id: "deepseek-v4-pro-search", modelType: "expert", searchEnabled: true, thinkingEnabled: false }),
  Object.freeze({ id: "deepseek-v4-reasoner-pro", modelType: "expert", searchEnabled: false, thinkingEnabled: true }),
  Object.freeze({ id: "deepseek-v4-reasoner-pro-search", modelType: "expert", searchEnabled: true, thinkingEnabled: true })
]);

const CHAT_MODEL_MAP = Object.freeze(
  Object.fromEntries(CHAT_MODELS.map((model) => [model.id, model]))
);

export function resolveChatModel(modelId) {
  const resolvedModel = CHAT_MODEL_MAP[modelId];

  if (!resolvedModel) {
    throw new Error(`Unsupported chat model: ${modelId}`);
  }

  return resolvedModel;
}
