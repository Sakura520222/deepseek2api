import { config } from "../config.js";

const DEFAULT_OPENAI_MODEL = "deepseek-chat-fast";
const SEARCH_MODEL_SUFFIX = "-search";

const BASE_OPENAI_MODELS = Object.freeze([
  Object.freeze({ id: "deepseek-chat-fast", modelType: "default", thinkingEnabled: false }),
  Object.freeze({ id: "deepseek-reasoner-fast", modelType: "default", thinkingEnabled: true }),
  Object.freeze({ id: "deepseek-chat-expert", modelType: "expert", thinkingEnabled: false }),
  Object.freeze({ id: "deepseek-reasoner-expert", modelType: "expert", thinkingEnabled: true }),
  Object.freeze({ id: "deepseek-v4-flash", modelType: "default", thinkingEnabled: false }),
  Object.freeze({ id: "deepseek-v4-reasoner-flash", modelType: "default", thinkingEnabled: true }),
  Object.freeze({ id: "deepseek-v4-pro", modelType: "expert", thinkingEnabled: false }),
  Object.freeze({ id: "deepseek-v4-reasoner-pro", modelType: "expert", thinkingEnabled: true })
]);

function createModelVariant(baseModel, searchEnabled) {
  return Object.freeze({
    ...baseModel,
    id: searchEnabled ? `${baseModel.id}${SEARCH_MODEL_SUFFIX}` : baseModel.id,
    searchEnabled
  });
}

const OPENAI_MODELS = Object.freeze(
  BASE_OPENAI_MODELS.flatMap((model) => [
    createModelVariant(model, false),
    createModelVariant(model, true)
  ])
);

const OPENAI_MODEL_MAP = Object.freeze(
  Object.fromEntries(OPENAI_MODELS.map((model) => [model.id, model]))
);

function createBadRequestError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

export function listOpenAiModels() {
  return OPENAI_MODELS.map(({ id }) => ({ id, object: "model" }));
}

export function resolveOpenAiModel(model) {
  const modelId = model ?? DEFAULT_OPENAI_MODEL;
  const resolvedModel = OPENAI_MODEL_MAP[modelId];

  if (!resolvedModel) {
    throw createBadRequestError(`Unsupported model: ${modelId}`);
  }

  return resolvedModel;
}

export function assertNoLegacySearchOptions(body) {
  if (Object.hasOwn(body ?? {}, "web_search_options")) {
    throw createBadRequestError(
      "Search is now controlled by model suffix '-search', not web_search_options"
    );
  }
}

export { DEFAULT_OPENAI_MODEL };

export function resolveToolCallModel(originalModel) {
  if (!config.toolCallModel) return originalModel;
  return resolveOpenAiModel(config.toolCallModel);
}
