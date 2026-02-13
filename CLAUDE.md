# CLAUDE.md — Event Watch

## Project Overview

Event Watch is a Node.js CLI tool that monitors industry event websites for date announcements and syncs with Google Calendar. It uses Claude AI (Haiku) to extract structured event data from web pages, with fallback URL discovery when primary sources fail.

## Architecture

```
event-watch.js          # CLI entry point (Commander.js)
events.json             # Config + event tracking data
lib/
  config.js             # JSON config read/write, filtering helpers
  scraper.js            # Web fetching, HTML→text (cheerio), robots.txt
  extractor.js          # Claude API integration for date extraction
  calendar.js           # Google Calendar CRUD (googleapis)
  search.js             # Fallback URL discovery (Brave/Google search)
  auth.js               # Google OAuth2 flow + token management
```

## Key Conventions

- **No TypeScript** — plain Node.js (CommonJS `require`)
- **Node >= 18** — uses native `fetch`, `AbortSignal.timeout`
- **Config-as-state** — `events.json` is both config and state store. It tracks URLs, last-known dates, last-checked timestamps, and Google Calendar event IDs.
- **Graceful degradation** — failures at any stage (fetch, extract, calendar) are logged and skipped; the tool continues to the next event.

## CLI Commands

| Command | Description |
|---------|-------------|
| `check` | Fetch + extract + calendar sync for all events |
| `check --dry-run` | Same but no calendar changes |
| `check --tag <t>` | Filter by tag |
| `check --month <m>` | Filter by typical month |
| `list` | Table view of all events |
| `list --tag <t>` | Filter list by tag |
| `list --missing-url` | Events needing URL discovery |
| `add --name "..." ...` | Add new event to tracking |
| `remove --name "..."` | Remove event from tracking |

## Data Flow (check command)

1. Load `events.json`
2. For each event:
   a. `scraper.fetchPage(url)` — fetch + cheerio HTML→text
   b. On failure → `search.discoverUrl()` — year increment, then web search
   c. `extractor.extractEventDates(text, eventInfo)` — Claude Haiku returns JSON
   d. Compare extracted dates vs `last_known`
   e. If changed → `calendar.upsertCalendarEvent()` — create or update
   f. Update config with new dates + timestamp
3. Save config

## Environment Variables (.env)

- `ANTHROPIC_API_KEY` — required for Claude extraction
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — required for Calendar
- `BRAVE_SEARCH_API_KEY` — optional, improves fallback URL discovery

## Events Config Schema

Each event in `events.json` has:
- `name` (string) — display name
- `url` (string|null) — primary source URL
- `tags` (string[]) — for filtering
- `typical_month` (string|null) — e.g. "March"
- `typical_location` (string|null)
- `organizer` (string|null)
- `last_known` (`{start, end}`|null) — YYYY-MM-DD dates
- `last_checked` (ISO string|null)
- `calendar_event_id` (string|null) — Google Calendar event ID
- `notes` (string|null) — optional context

## Claude Extraction Prompt

The prompt to Claude Haiku asks for structured JSON:
```json
{
  "start_date": "YYYY-MM-DD",
  "end_date": "YYYY-MM-DD",
  "location": "string",
  "venue": "string",
  "city": "string",
  "registration_url": "string",
  "confidence": "confirmed|tentative|not_found",
  "raw_excerpt": "string"
}
```

## Calendar Integration

- Uses Google Calendar API v3 via `googleapis`
- OAuth2 Desktop app flow with local HTTP callback on port 3000
- Token persisted to `token.json`
- Events color-coded grape (colorId: 3)
- Reminders at 6 weeks (email) and 2 weeks (popup)
- End dates are exclusive in Google Calendar (1 day added automatically)

## Fallback URL Discovery Order

1. Year increment — replace year in existing URL path
2. Brave Search API — structured results (if API key set)
3. Google Search scraping — extract URLs from search results
4. Match by domain, organizer name, or event name keywords

## Common Development Tasks

```bash
# Install dependencies
npm install

# Run a dry check
node event-watch.js check --dry-run

# Check specific tag
node event-watch.js check --tag quantum --dry-run

# List events missing URLs
node event-watch.js list --missing-url

# Add an event
node event-watch.js add --name "Test Event" --url "https://example.com" --tags "test" --month "June"
```

## Important Notes

- Never commit `.env` or `token.json` (both in `.gitignore`)
- `events.json` IS committed — it's the seed/state file
- The scraper respects `robots.txt` and uses a polite user-agent
- Page content is truncated to ~15k chars before sending to Claude
- Google search scraping is a best-effort fallback; Brave Search API is preferred
