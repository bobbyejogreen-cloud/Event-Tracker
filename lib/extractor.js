const Anthropic = require('@anthropic-ai/sdk');

let client = null;

function getClient() {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('Missing ANTHROPIC_API_KEY in .env file');
    }
    client = new Anthropic();
  }
  return client;
}

async function extractEventDates(pageText, eventInfo) {
  const anthropic = getClient();

  const currentYear = new Date().getFullYear();
  const nextYear = currentYear + 1;

  const prompt = `You are analyzing a webpage to extract event date information.

Event we're looking for: "${eventInfo.name}"
Organizer: ${eventInfo.organizer || 'Unknown'}
Typical month: ${eventInfo.typical_month || 'Unknown'}
Typical location: ${eventInfo.typical_location || 'Unknown'}
Last known dates: ${eventInfo.last_known ? `${eventInfo.last_known.start} to ${eventInfo.last_known.end}` : 'None'}

Here is the text content from the event webpage:

---
${pageText}
---

Extract the following information about the UPCOMING or NEXT edition of this event (${currentYear} or ${nextYear}). Return ONLY valid JSON with no markdown formatting:

{
  "start_date": "YYYY-MM-DD or null",
  "end_date": "YYYY-MM-DD or null",
  "start_time": "HH:MM (24-hour) or null",
  "end_time": "HH:MM (24-hour) or null",
  "timezone": "IANA timezone (e.g. America/New_York) or null",
  "location": "Full location string or null",
  "venue": "Venue name or null",
  "city": "City name or null",
  "registration_url": "URL or null",
  "confidence": "confirmed|tentative|not_found",
  "raw_excerpt": "The exact text snippet where you found the dates (max 200 chars) or null"
}

Rules:
- "confirmed" = dates are explicitly stated on the page
- "tentative" = dates are implied or estimated (e.g., "Fall 2026", a countdown, or based on past patterns)
- "not_found" = no date information could be extracted
- For tentative dates, use the best estimate in YYYY-MM-DD format
- If only a start date is found, set end_date to the same as start_date
- Look for the NEXT upcoming event, not past events
- Include start_time and end_time if specific times are mentioned (e.g. "9:00 AM - 5:00 PM"). Use 24-hour format. Only include times if they are explicitly stated.
- Include timezone based on the event location (e.g. America/New_York for DC/East Coast, America/Chicago for Central, America/Denver for Mountain, America/Los_Angeles for West Coast)
- Return raw JSON only, no code fences`;

  try {
    let response;
    const MAX_RETRIES = 3;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        response = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1024,
          messages: [{ role: 'user', content: prompt }],
        });
        break;
      } catch (apiErr) {
        const isRetryable = apiErr.status === 429 || apiErr.status === 529 || apiErr.status >= 500;
        if (!isRetryable || attempt === MAX_RETRIES) throw apiErr;
        const delay = Math.pow(2, attempt + 1) * 1000; // 2s, 4s, 8s
        console.log(`  Rate limited (${apiErr.status}), retrying in ${delay / 1000}s...`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    const text = response.content[0].text.trim();

    // Try to parse JSON, handling potential markdown wrapping
    let jsonStr = text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      jsonStr = jsonMatch[0];
    }

    const result = JSON.parse(jsonStr);

    // Validate required fields
    if (!result.confidence) {
      result.confidence = 'not_found';
    }

    return result;
  } catch (err) {
    console.error(`  Claude extraction error: ${err.message}`);
    return {
      start_date: null,
      end_date: null,
      location: null,
      venue: null,
      city: null,
      registration_url: null,
      confidence: 'not_found',
      raw_excerpt: null,
    };
  }
}

module.exports = { extractEventDates };
