export async function onRequest(context) {
  const apiOrigin = context.env.AI_AGENT_API_ORIGIN || "https://kalkibot-ai-trade-agent.srimanthgada87.workers.dev";
  const path = Array.isArray(context.params.path) ? context.params.path.join("/") : "";
  const sourceUrl = new URL(context.request.url);
  const target = new URL(`/api/${path}`, apiOrigin);
  target.search = sourceUrl.search;

  return fetch(target, {
    method: context.request.method,
    headers: context.request.headers,
    body: context.request.body,
  });
}
