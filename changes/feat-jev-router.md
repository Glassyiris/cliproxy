Added

- Model routers: a client names a router from `model-routers` (for example `smart`) as its model. A judge grades the user message from 0 to 4, and the cheapest candidate whose Artificial Analysis intelligence index meets that difficulty serves the request. The judge is Jev through its provider, or any chat model of the proxy.
- A conversation keeps its routed model through its agent loop, so its prompt cache stays warm. It moves to a stronger model only on a new user message, or when its model becomes unavailable, leaves the router's list or is too small for the context.
- Benchmarks and prices come from the Artificial Analysis API (`artificial-analysis.api-key`), are cached and refresh daily.
- `routing.providers.exclude` keeps providers away from models named without a prefix, and `routing.providers.order` ranks providers in tiers. A router can narrow and reorder providers for its own requests with a `providers` block.
- `fallback-models` moves a failed request to another model, but never one that a stop rule or a plugin ended. The Antigravity credits fallback stays inside the request's provider scope.
- Responses carry `X-CPA-Routed-Model` when a router chose the model, and `X-CPA-Routed-Provider` when `routing.providers` excludes or orders something or a router served the request. Without `model-routers` and `routing.providers`, responses are unchanged.
