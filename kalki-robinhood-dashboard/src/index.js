export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "kalki-robinhood-dashboard",
        mode: "prototype",
      });
    }

    return env.ASSETS.fetch(request);
  },
};
