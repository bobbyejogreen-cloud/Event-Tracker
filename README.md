# Event Watch

A Node.js CLI tool that monitors industry event websites for date announcements and automatically creates/updates Google Calendar events. Uses Claude AI to extract event dates from web pages.

## How It Works

1. Reads `events.json` containing a list of events to track
2. Fetches each event's webpage and strips HTML to readable text
3. Sends page content to Claude API (Haiku) to extract dates, location, venue, and registration info
4. Compares extracted dates against last-known dates in config
5. Creates or updates Google Calendar events when dates change
6. Updates `events.json` with new dates and timestamps
7. Prints a summary of changes

### Fallback URL Discovery

When an event URL is null, returns 404, or has no usable content:

1. **Year increment** — If the URL contains a 4-digit year, tries the next year
2. **Web search** — Searches for the event name + organizer + year to discover the URL
3. **Parse & update** — If new dates are found, saves the working URL to config for future checks

## Setup

### 1. Google Cloud Project (Calendar API)

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project (e.g., "event-watch")
3. Navigate to **APIs & Services > Library**
4. Search for and enable **Google Calendar API**
5. Go to **APIs & Services > Credentials**
6. Click **Create Credentials > OAuth 2.0 Client ID**
7. Select **Desktop application** as the application type
8. Download the credentials — copy the Client ID and Client Secret to your `.env` file

### 2. Anthropic API Key

1. Go to [Anthropic Console](https://console.anthropic.com)
2. Create an API key
3. Add to `.env` as `ANTHROPIC_API_KEY`

### 3. Environment Variables

```bash
cp .env.example .env
# Edit .env with your actual credentials
```

### 4. Install Dependencies

```bash
npm install
```

### 5. First Run (Google OAuth Flow)

The first run will open your browser for Google OAuth authentication:

```bash
node event-watch.js check --dry-run
```

This saves a `token.json` file for subsequent runs.

## Usage

### Check all events
```bash
node event-watch.js check
```

### Dry run (no calendar changes)
```bash
node event-watch.js check --dry-run
```

### Check events by tag
```bash
node event-watch.js check --tag defense
```

### Check events by typical month
```bash
node event-watch.js check --month March
```

### List all tracked events
```bash
node event-watch.js list
```

### List events by tag
```bash
node event-watch.js list --tag quantum
```

### List events needing URL discovery
```bash
node event-watch.js list --missing-url
```

### Add a new event
```bash
node event-watch.js add \
  --name "Event Name" \
  --url "https://example.com" \
  --tags "tag1,tag2" \
  --month "March" \
  --location "DC" \
  --organizer "Org Name"
```

### Remove an event
```bash
node event-watch.js remove --name "Event Name"
```

## Scheduling (Optional)

Add a cron job to run weekly:

```cron
# Every Monday at 8am
0 8 * * 1 cd /path/to/event-watch && node event-watch.js check >> check.log 2>&1
```

## Project Structure

```
event-watch.js          # CLI entry point
events.json             # Event tracking config (seed data)
lib/
  config.js             # Config file read/write
  scraper.js            # Web fetching + HTML-to-text
  extractor.js          # Claude API date extraction
  calendar.js           # Google Calendar integration
  search.js             # Fallback URL discovery
  auth.js               # Google OAuth2 flow
```

## Calendar Event Details

Created calendar events include:
- Event name as title
- Location/venue in the location field
- Description with source URL, tags, organizer, and registration link
- Reminders at 6 weeks and 2 weeks before
- Color-coded (grape/purple) to distinguish from regular events

## Error Handling

- Failed web fetches trigger fallback URL discovery before skipping
- `not_found` confidence from Claude skips calendar creation
- Google Calendar API failures still save extracted dates to config
- All errors are logged with the event name for easy debugging
