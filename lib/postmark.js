// Minimal Postmark API client (uses Node's built-in fetch).

const BATCH_SIZE = 500; // Postmark's limit per /email/batch call
const SEARCH_PAGE = 500;
const SEARCH_LIMIT = 10000; // Postmark caps count + offset at 10,000

class PostmarkClient {
  constructor(token, { baseUrl = process.env.POSTMARK_API_URL || "https://api.postmarkapp.com" } = {}) {
    if (!token) throw new Error("POSTMARK_SERVER_TOKEN isn't set.");
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async request(method, path, body) {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Postmark-Server-Token": this.token,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { Message: text };
    }
    if (!res.ok) {
      const err = new Error(`Postmark ${method} ${path} failed (${res.status}): ${json.Message || text}`);
      err.status = res.status;
      err.errorCode = json.ErrorCode;
      throw err;
    }
    return json;
  }

  // Addresses that already received a message with this tag on this stream.
  async sentRecipients(tag, messageStream) {
    const sent = new Set();
    for (let offset = 0; offset + SEARCH_PAGE <= SEARCH_LIMIT; offset += SEARCH_PAGE) {
      const q = new URLSearchParams({ count: SEARCH_PAGE, offset, tag, messagestream: messageStream });
      const page = await this.request("GET", `/messages/outbound?${q}`);
      const messages = page.Messages || [];
      for (const m of messages) {
        for (const r of m.Recipients || []) sent.add(String(r).toLowerCase());
        for (const t of Array.isArray(m.To) ? m.To : []) if (t && t.Email) sent.add(String(t.Email).toLowerCase());
      }
      if (messages.length < SEARCH_PAGE || offset + SEARCH_PAGE >= (page.TotalCount || 0)) return sent;
    }
    throw new Error(`More than ${SEARCH_LIMIT} messages already sent with tag "${tag}"; too many to check safely.`);
  }

  // Addresses Postmark won't deliver to on this stream (unsubscribed, bounced, complained).
  async suppressed(messageStream) {
    const res = await this.request("GET", `/message-streams/${encodeURIComponent(messageStream)}/suppressions/dump`);
    return new Set((res.Suppressions || []).map((s) => String(s.EmailAddress).toLowerCase()));
  }

  async sendBatch(messages) {
    const results = [];
    for (let i = 0; i < messages.length; i += BATCH_SIZE) {
      const chunk = messages.slice(i, i + BATCH_SIZE);
      const res = await this.request("POST", "/email/batch", chunk);
      results.push(...res);
    }
    return results;
  }
}

module.exports = { PostmarkClient, BATCH_SIZE };
