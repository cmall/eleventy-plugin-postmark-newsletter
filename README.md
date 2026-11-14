# eleventy-plugin-postmark-newsletter

Run a small email newsletter from an Eleventy site, without a newsletter service.

- **Write** each newsletter as a Markdown file with a `subject` and a `sendDate`, using an email layout you control.
- **Send** with Postmark's broadcast stream. A scheduled job sends whatever is due, and re-running it never sends anyone a second copy.
- **Unsubscribes** are handled by Postmark's unsubscribe link and suppression list.
- **Signups** go to a small Cloudflare Worker (included) with double opt-in, Cloudflare Turnstile, a honeypot and a domain check, so fake addresses never make it onto your list.

## How it fits together

```
signup form ──► Cloudflare Worker ──► D1 database (pending → active)
                    │  └─ confirmation email via Postmark (transactional stream)
                    ▲
Postmark "subscription change" webhook (unsubscribes, bounces)

scheduled job ──► eleventy-newsletter send
                    ├─ renders src/newsletters/*.md in memory with your layout
                    ├─ reads active subscribers from the Worker
                    ├─ asks Postmark who is suppressed and who already got this one
                    └─ sends the rest through the Postmark broadcast stream
```

Newsletters are left out of normal builds, so a scheduled issue is never published on your site early. While `eleventy --serve` runs, each one renders as a preview page.

## Requirements

- Eleventy 2 or 3, and Node 18.17 or newer
- A Postmark account with a broadcast message stream and a verified sending domain
- A Cloudflare account for the signup Worker (the free plan is enough), or your own subscriber source

## Install

```sh
npm install eleventy-plugin-postmark-newsletter
npx eleventy-newsletter init      # adds a starter layout, data file and example newsletter
```

```js
// eleventy.config.js
const newsletter = require("eleventy-plugin-postmark-newsletter");

module.exports = function (eleventyConfig) {
  eleventyConfig.addPlugin(newsletter, {
    siteUrl: "https://example.com",
    from: "Your Name <you@example.com>",
    timezone: "America/Vancouver",
    subscribers: "https://newsletter.your-account.workers.dev/subscribers",
  });
};
```

`init` creates:

| File | Purpose |
| --- | --- |
| `<input>/_includes/layouts/newsletter.njk` | The email layout. Plain CSS in a `<style>` block is inlined at send time. |
| `<input>/newsletters/newsletters.11tydata.json` | Applies the layout and keeps newsletters out of collections. |
| `<input>/newsletters/example.md` | An example, marked `draft: true`. |

## Writing a newsletter

```md
---
subject: December news
preheader: The short line inboxes show after the subject.
sendDate: 2026-12-01 09:00
---

Hi everyone,

Here are my latest posts:

{% for post in collections.posts limit: 3 -%}
- [{{ post.data.title }}]({{ post.url }})
{% endfor %}
```

| Front matter | |
| --- | --- |
| `subject` | Required. Falls back to `title`. |
| `sendDate` | Optional. When to send. `2026-12-01 09:00` is read in the plugin's `timezone`, and `2026-12-01` alone uses `defaultSendTime`. Add an offset (`2026-12-01T09:00-08:00`) or `Z` for an exact moment. Leave it out to send as soon as the newsletter is pushed (see below). |
| `preheader` | Optional preview text. The starter layout hides it in the email body. |
| `draft: true` | Never sent. |
| `slug` | Optional. Defaults to the file name, and is used for the Postmark tag. |

The whole site is available while a newsletter renders, so collections, global data, shortcodes and filters all work. Links and images that start with `/` are rewritten to absolute URLs using `siteUrl`.

Put `{% newsletterUnsubscribeUrl %}` in the layout where the unsubscribe link should go. Postmark replaces it with each recipient's own link. If it's missing, Postmark adds a link at the bottom.

### Sending without a sendDate

Leave `sendDate` out and the newsletter goes out on the first `send` after it's committed. Run `send` right after each deploy and that means "as soon as it's live" (see the workflow below).

The send time comes from git history: the commit where the file became ready, meaning not a draft and no `sendDate`. So:

- fixing a typo after it's sent doesn't change anything
- a newsletter committed with `draft: true` goes out when you commit it without the draft line
- removing the `sendDate` from a scheduled newsletter sends it at that commit
- an uncommitted file never sends, and neither does a folder without git history (the sender stops with an error rather than guess)

Keep `draft: true` on a newsletter while you're writing it. Without that line and without a `sendDate`, pushing it sends it. The sender needs full git history, so use `fetch-depth: 0` in GitHub Actions. To require a date on every newsletter instead, set `sendUndated: false`.

> **Don't rename a newsletter's file after it has been sent.** The file name becomes the Postmark tag, and the tag is how already-sent recipients are found.

## Sending

```sh
npx eleventy-newsletter list                 # status and send time of every newsletter
npx eleventy-newsletter send --dry-run       # who would get what, sends nothing
npx eleventy-newsletter send                 # send everything that's due, plus any new previews
npx eleventy-newsletter test --to you@example.com [--only december-news]
```

A newsletter is **due** once its `sendDate` has passed, and stays due for `maxAgeDays` (7 by default). After that it's **expired** and won't go out on its own, so an old file never sends by surprise. To send an expired one anyway, run `send --only <name> --late`.

`send` is safe to run as often as you like. Before sending, it asks Postmark which addresses already received a message with that newsletter's tag and skips them. A retry after a failure, or a subscriber added later, gets exactly one copy. This relies on Postmark keeping the message history: the default retention is 45 days, which is well beyond `maxAgeDays`.

Environment variables:

| Variable | |
| --- | --- |
| `POSTMARK_SERVER_TOKEN` | Postmark server API token. |
| `NEWSLETTER_SUBSCRIBERS_TOKEN` | Sent as `Authorization: Bearer …` when `subscribers` is a URL. |
| `NEWSLETTER_SUBSCRIBERS` | Overrides the `subscribers` option. |
| `NEWSLETTER_PREVIEW_TO` | Overrides the `previewTo` option. |

### Previews of drafts and scheduled newsletters

Set `previewTo` (or `NEWSLETTER_PREVIEW_TO`) to your own address, and `send` also emails you each **draft** and **scheduled** newsletter, once per version. Push a change and you get the new version; push something unrelated and you get nothing. Each version is fingerprinted from its subject and rendered HTML, and recorded as a Postmark tag, so there's nothing to store.

Previews and `test` sends go through `previewStream` (a transactional stream, `outbound` by default), with a banner at the top and the unsubscribe link turned off. Clicking it in your copy can't unsubscribe you. If your layout prints something that changes on every build, such as the current time, every run counts as a new version.

The sender builds your site in memory, so run any steps your templates depend on (such as compiling CSS that a layout includes) before `send`.

### Scheduling with GitHub Actions

```yaml
name: Newsletter
on:
  workflow_run: # right after your deploy workflow finishes
    workflows: ["Deploy"]
    types: [completed]
  schedule:
    - cron: "17 * * * *" # hourly, for newsletters with a sendDate
  workflow_dispatch:
concurrency: { group: newsletter, cancel-in-progress: false }
jobs:
  send:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 } # needed for newsletters without a sendDate
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npx eleventy-newsletter send
        env:
          POSTMARK_SERVER_TOKEN: ${{ secrets.POSTMARK_SERVER_TOKEN }}
          NEWSLETTER_SUBSCRIBERS_TOKEN: ${{ secrets.NEWSLETTER_SUBSCRIBERS_TOKEN }}
```

An hourly run uses roughly 720 Actions minutes a month. In a private repository on GitHub's free plan, check that against your allowance, or run it less often.

## Options

| Option | Default | |
| --- | --- | --- |
| `siteUrl` | `""` | Your site's URL. Needed for absolute links and images. |
| `from` | `""` | Sender. Must be verified in Postmark. |
| `replyTo` | `""` | Optional reply-to address. |
| `timezone` | `"UTC"` | IANA zone used for `sendDate` values without an offset. |
| `defaultSendTime` | `"09:00"` | Time used when `sendDate` is only a date. |
| `messageStream` | `"broadcast"` | Postmark broadcast stream ID. |
| `previewTo` | `[]` | Your address(es) for previews of drafts and scheduled newsletters. |
| `previewStream` | `"outbound"` | Postmark transactional stream for previews and `test` sends. |
| `subscribers` | `null` | A URL that returns JSON, a `.json` or `.csv` path, or an async function. See below. |
| `dir` | `"newsletters"` | Folder inside your input folder. |
| `sendUndated` | `true` | Send newsletters that have no `sendDate` from the commit where they became ready. |
| `maxAgeDays` | `7` | How long after `sendDate` a newsletter can still go out automatically. |
| `tagPrefix` | `"newsletter-"` | Prefix for Postmark tags. |
| `inlineCss` | `true` | Inline `<style>` rules into `style=""` attributes. |
| `previewInServe` | `true` | Render previews during `eleventy --serve`. |
| `trackOpens`, `trackLinks` | `false`, `"None"` | Postmark tracking settings. |

### Subscriber sources

`subscribers` can be:

- **A URL** that returns `[{ "email": "…", "name": "…" }]` or `{ "subscribers": [...] }`. The Worker's `/subscribers` endpoint returns this.
- **A file**: `.json` in the same shape, or `.csv` with an `email` (or `Email Address`) column, plus optional `first_name`/`last_name` or `name`.
- **A function**: `async () => [{ email, name }]`, if your list lives somewhere else.

Addresses are lowercased and de-duplicated, and invalid ones are skipped.

## The signup Worker

`worker/index.mjs` is a complete Cloudflare Worker backed by D1:

| Route | |
| --- | --- |
| `POST /subscribe` | Form target (`email`, optional `first_name`, `last_name`). Sends a confirmation email. Answers with a redirect, or JSON if the request sends `Accept: application/json`. |
| `GET /confirm?token=…` | Shows a **Confirm** button. Confirming takes a click, so email link scanners can't confirm for someone. |
| `POST /confirm` | Activates the subscriber. |
| `GET /subscribers` | Active subscribers. Needs `Authorization: Bearer SUBSCRIBERS_TOKEN`. |
| `POST /webhooks/postmark` | Postmark's **Subscription change** webhook, using basic auth with `WEBHOOK_SECRET` as the password. Keeps unsubscribes, bounces and resubscribes in sync. |
| cron | Deletes signups that were never confirmed after 30 days. |

Protection against fake signups:

- **Double opt-in:** nobody is added until they confirm, and the sender only reads active subscribers.
- **Cloudflare Turnstile:** on when `TURNSTILE_SECRET_KEY` is set. Add the widget to your form.
- **Honeypot:** a hidden `website` field. Bots that fill it get a normal-looking response and nothing else happens.
- **Domain check:** the email's domain must exist and accept mail (MX record). If DNS can't be reached, the signup is allowed.
- **Rate limits:** one confirmation email per address every 10 minutes, and `MAX_CONFIRMATIONS_PER_HOUR` (30) overall.

### Deploy

```sh
cp node_modules/eleventy-plugin-postmark-newsletter/worker/wrangler.example.toml newsletter-worker/wrangler.toml
cd newsletter-worker
npx wrangler d1 create newsletter                       # paste the database_id into wrangler.toml
npx wrangler d1 execute newsletter --remote --file=../node_modules/eleventy-plugin-postmark-newsletter/worker/schema.sql
npx wrangler secret put POSTMARK_SERVER_TOKEN
npx wrangler secret put SUBSCRIBERS_TOKEN               # e.g. output of: openssl rand -hex 32
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put TURNSTILE_SECRET_KEY            # optional
npx wrangler deploy
```

Then in Postmark, open your broadcast stream's **Webhooks** and add `https://<worker>/webhooks/postmark` for **Subscription change** events, with basic auth username `postmark` and your `WEBHOOK_SECRET` as the password.

By default the Worker redirects to `/subscribe/check-email/`, `/subscribe/confirmed/` and `/subscribe/problem/?reason=…` on `SITE_URL`. Create those pages, or set `PENDING_URL`, `CONFIRMED_URL` and `ERROR_URL`.

### Signup form

```html
<form action="https://<worker>/subscribe" method="post">
  <input type="email" name="email" required autocomplete="email">
  <input type="text" name="first_name" autocomplete="given-name">
  <div style="position:absolute;left:-5000px" aria-hidden="true">
    <input type="text" name="website" tabindex="-1" autocomplete="off">
  </div>
  <div class="cf-turnstile" data-sitekey="YOUR_SITE_KEY"></div>
  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
  <button type="submit">Subscribe</button>
</form>
```

### Importing an existing list

```sh
npx eleventy-newsletter import subscribed_members.csv > import.sql
npx wrangler d1 execute newsletter --remote --file=import.sql
```

This works with a Mailchimp audience export or any CSV with an email column. Imported people are marked active, and existing rows are never overwritten. Pass `--unsubscribed` to record an unsubscribed export instead. Delete `import.sql` afterwards, since it contains your subscribers' addresses.

## Notes

- **Resubscribing:** when someone who unsubscribed signs up and confirms again, the Worker asks Postmark to lift the suppression. If Postmark doesn't allow that for a recipient-initiated unsubscribe, they can resubscribe from Postmark's own unsubscribe confirmation page.
- **Time zones** come from the time zone database bundled with Node. Rules do change (British Columbia's did in 2026), so keep the Node that runs `send` reasonably current, or use explicit offsets.
- **Previews** are written to your output folder during `eleventy --serve`. If you ever deploy a locally built output folder, build it with a plain `eleventy` run first.

## License

MIT
