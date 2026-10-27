# AI/ML API

The `aimlapi` key preset in `src/providers/registry/entries-extended.ts` uses the existing OpenAI Chat adapter at `https://api.aimlapi.com/v1`.
Its public `GET /v1/models` mixes chat, image, video, audio, embedding and Anthropic-batch rows,
and only the row `type` tells them apart, so registry-owned discovery admits rows whose `type` is
`openai/chat-completions`. The catalog answers 200 for any Bearer value, so key validation is
`unknown`. Seven vendor-prefixed chat ids are seeded with their catalog context and output limits.
The preset's `staticHeaders` carry `X-AIMLAPI-Source` and `X-AIMLAPI-Partner-ID` attribution.
Registry static headers reach an upstream only while the row matches the registry transport; for a
same-named row retargeted to another URL, `withoutRegistryStaticHeaderCopies` in
`src/providers/registry.ts` drops the seeded copies on inference (`src/providers/routed-config.ts`)
and model discovery (`src/oauth/index.ts`), while a header the operator wrote or changed is kept.
`tests/providers/aimlapi-provider.test.ts` covers derived entry points, type-filtered discovery,
key validation, routing, and the headers on the wire for the preset and a retargeted row.
