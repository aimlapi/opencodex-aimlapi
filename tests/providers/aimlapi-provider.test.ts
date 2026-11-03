import { afterEach, describe, expect, test } from "bun:test";
import { gatherRoutedModels } from "../../src/codex/catalog";
import { clearModelCache } from "../../src/codex/model-cache";
import { buildModelsRequest } from "../../src/oauth";
import { KEY_LOGIN_PROVIDERS, validateApiKey } from "../../src/oauth/key-providers";
import { deriveInitProviders, deriveKeyLoginMap, deriveProviderPresets, providerConfigSeed } from "../../src/providers/derive";
import { extractProviderModelItems, providerModelDiscoverySpecError, resolveProviderModelDiscovery } from "../../src/providers/model-discovery";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { routeModel } from "../../src/router";
import { resolveWireProtocolOverride } from "../../src/server/adapter-resolve";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { isModelVisionSidecarConsumer } from "../../src/vision/eligibility";
import { withStubbedProviderFetch } from "../helpers/catalog-provider-fetch";

const originalFetch = globalThis.fetch;
const baseUrl = "https://api.aimlapi.com/v1";
const RELAY = "https://relay.example.test/v1";
// Chat Completions rows of the public GET /v1/models, each answering chat, streaming and a tool
// call on 2026-10-27.
const SEEDS = [
  "openai/gpt-5.6-terra", "openai/gpt-6.1-terra", "anthropic/claude-sonnet-5-5", "google/gemini-3.5-flash",
  "deepseek/deepseek-v4-flash", "z-ai/glm-5.3-flash", "moonshot/kimi-k3",
] as const;
// Row shapes of the public GET /v1/models: only `type` tells a chat row from the rest, and one id
// can appear once per type it is served on.
const CATALOG = { object: "list", data: [
  { id: "openai/gpt-5.6-terra", type: "openai/chat-completions", aliases: ["gpt-5.6-terra"], info: {} },
  { id: "openai/gpt-5.6-terra", type: "openai/responses/submit", aliases: [], info: {} },
  { id: "anthropic/claude-sonnet-5-5", type: "anthropic/messages", aliases: [], info: {} },
  { id: "anthropic/claude-sonnet-5-5", type: "anthropic/batches", aliases: [], info: {} },
  { id: "anthropic/claude-sonnet-5-5", type: "openai/chat-completions", aliases: [], info: {} },
  { id: "flux/schnell", type: "openai/image-generations", aliases: [], info: {} },
  { id: "google/veo-3.1", type: "internal/video-generations/submit", aliases: [], info: {} },
  { id: "openai/text-embedding-3-small", type: "openai/embeddings", aliases: [], info: {} },
  { id: "elevenlabs/eleven_v3", type: "internal/text-to-speech", aliases: [], info: {} },
  { id: "untyped/row", aliases: [], info: {} },
] };

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache("aimlapi");
});

function entry() {
  const row = PROVIDER_REGISTRY.find(candidate => candidate.id === "aimlapi");
  if (!row) throw new Error("missing AI/ML API preset");
  return row;
}

function config(overrides: Partial<OcxProviderConfig> = {}): OcxConfig {
  return withStubbedProviderFetch({
    port: 10100,
    defaultProvider: "aimlapi",
    providers: { aimlapi: { ...providerConfigSeed(entry()), apiKey: "test-key", ...overrides } },
  });
}

describe("AI/ML API provider", () => {
  test("is offered by ocx provider add, ocx init and the dashboard picker", () => {
    expect(deriveInitProviders().find(row => row.id === "aimlapi")).toMatchObject({
      label: "AI/ML API", kind: "key", adapter: "openai-chat", baseUrl,
    });
    const preset = deriveProviderPresets().find(row => row.id === "aimlapi");
    expect(preset).toMatchObject({ auth: "key", dashboardUrl: "https://aimlapi.com/app/keys" });
    expect(preset?.sponsor).toBeUndefined();
    expect(entry().staticHeaders).toBeUndefined();
    expect(KEY_LOGIN_PROVIDERS.aimlapi?.defaultModel).toBe("openai/gpt-5.6-terra");
  });

  test("seeds the verified chat models with their catalog limits and live discovery on", () => {
    const seeded = config().providers.aimlapi!;
    expect(seeded).toMatchObject({ adapter: "openai-chat", baseUrl, defaultModel: "openai/gpt-5.6-terra", liveModels: true });
    expect(entry().models).toEqual([...SEEDS]);
    for (const model of SEEDS) expect(seeded.modelContextWindows?.[model]).toBeGreaterThanOrEqual(1_000_000);
    // DeepSeek V4 Flash is the one text-only seed: an image goes to the vision sidecar first.
    expect(isModelVisionSidecarConsumer(seeded, "deepseek/deepseek-v4-flash")).toBe(true);
    expect(isModelVisionSidecarConsumer(seeded, "openai/gpt-5.6-terra")).toBe(false);
  });

  test.each(SEEDS)("%s routes over Chat with its vendor-prefixed upstream id unchanged", model => {
    const route = routeModel(config(), `aimlapi/${model}`);
    expect(route.modelId).toBe(model);
    expect(route.provider).toMatchObject({ adapter: "openai-chat", baseUrl });
    for (const inbound of ["responses", "chat", "anthropic"] as const) {
      expect(resolveWireProtocolOverride("aimlapi", model, config().providers.aimlapi!, inbound).adapter)
        .toBe("openai-chat");
    }
  });

  test("keeps a same-named custom destination instead of retargeting it", () => {
    expect(routeModel(config({ baseUrl: RELAY }), "aimlapi/custom-model").provider.baseUrl).toBe(RELAY);
  });

  test("live discovery admits only Chat Completions rows, so image, video and audio models stay out", () => {
    const discovery = resolveProviderModelDiscovery("aimlapi", config().providers.aimlapi!);
    expect(providerModelDiscoverySpecError(entry().modelDiscovery!)).toBeNull();
    expect(buildModelsRequest(config().providers.aimlapi!, "test-key", "aimlapi").url).toBe(`${baseUrl}/models`);
    const result = extractProviderModelItems(CATALOG, discovery);
    if (!result.ok) throw new Error(result.reason);
    expect(result.items.map(row => row.id)).toEqual(["openai/gpt-5.6-terra", "anthropic/claude-sonnet-5-5"]);
  });

  test("the routed model list carries the chat rows only", async () => {
    globalThis.fetch = (async input => {
      expect(String(input)).toBe(`${baseUrl}/models`);
      return Response.json(CATALOG);
    }) as typeof fetch;
    const models = (await gatherRoutedModels(config())).filter(row => row.provider === "aimlapi");
    expect(models.map(row => row.id).sort()).toEqual(["anthropic/claude-sonnet-5-5", "openai/gpt-5.6-terra"]);
  });

  test("the public catalog is never probed to validate a key", async () => {
    expect(deriveKeyLoginMap().aimlapi?.apiKeyValidation).toBe("unknown");
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return Response.json({ object: "list", data: [] }); }) as unknown as typeof fetch;
    expect(await validateApiKey("aimlapi", KEY_LOGIN_PROVIDERS.aimlapi!, "any-key")).toBe("unknown");
    expect(calls).toBe(0);
  });
});
