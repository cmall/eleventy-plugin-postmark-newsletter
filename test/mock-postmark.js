const http = require("node:http");

// A tiny stand-in for the Postmark API.
function mockPostmark() {
  const sent = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const reply = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers["x-postmark-server-token"] !== "test-token") return reply(401, { ErrorCode: 10, Message: "Bad token" });
    if (req.method === "GET" && url.pathname === "/message-streams/broadcast/suppressions/dump") {
      return reply(200, { Suppressions: [{ EmailAddress: "UNSUB@example.com", SuppressionReason: "ManualSuppression" }] });
    }
    if (req.method === "GET" && url.pathname === "/messages/outbound") {
      const tag = url.searchParams.get("tag");
      const offset = +url.searchParams.get("offset");
      const count = +url.searchParams.get("count");
      const matches = sent.filter((m) => m.Tag === tag && m.MessageStream === url.searchParams.get("messagestream"));
      return reply(200, {
        TotalCount: matches.length,
        Messages: matches.slice(offset, offset + count).map((m) => ({ Recipients: [m.To.replace(/.*</, "").replace(/>$/, "")], Tag: m.Tag })),
      });
    }
    if (req.method === "POST" && url.pathname === "/email/batch") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const messages = JSON.parse(body);
      sent.push(...messages);
      return reply(200, messages.map((m) => ({ ErrorCode: 0, Message: "OK", To: m.To, MessageID: "id" })));
    }
    reply(404, { Message: "not found" });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, sent, url: `http://127.0.0.1:${server.address().port}` }))
  );
}

module.exports = { mockPostmark };
