const { fetchPage, tryYearIncrement, USER_AGENT } = require('./scraper');

async function discoverUrl(eventInfo) {
  const results = [];

  // Step 1: Try year increment on existing URL
  if (eventInfo.url) {
    const incrementedUrl = tryYearIncrement(eventInfo.url);
    if (incrementedUrl) {
      console.log(`  Trying year-incremented URL: ${incrementedUrl}`);
      const result = await fetchPage(incrementedUrl);
      if (result.success) {
        return { url: incrementedUrl, text: result.text, method: 'year-increment' };
      }
    }
  }

  // Step 2: Web search fallback
  const searchQuery = buildSearchQuery(eventInfo);
  console.log(`  Searching: "${searchQuery}"`);

  // Try Brave Search API first (if key available)
  if (process.env.BRAVE_SEARCH_API_KEY) {
    const braveResult = await braveSearch(searchQuery, eventInfo);
    if (braveResult) return braveResult;
  }

  // Fallback to Google search scraping
  const googleResult = await googleSearch(searchQuery, eventInfo);
  if (googleResult) return googleResult;

  return null;
}

function buildSearchQuery(eventInfo) {
  const currentYear = new Date().getFullYear();
  const nextYear = currentYear + 1;
  const targetYear =
    eventInfo.typical_month && isMonthPast(eventInfo.typical_month)
      ? nextYear
      : currentYear;

  const parts = [eventInfo.name];
  if (eventInfo.organizer) parts.push(eventInfo.organizer);
  parts.push(String(targetYear));
  parts.push('dates location');

  return parts.join(' ');
}

function isMonthPast(monthName) {
  const months = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december',
  ];
  const idx = months.indexOf(monthName.toLowerCase());
  if (idx === -1) return false;
  return idx < new Date().getMonth();
}

async function braveSearch(query, eventInfo) {
  try {
    const params = new URLSearchParams({ q: query, count: '5' });
    const resp = await fetch(
      `https://api.search.brave.com/res/v1/web/search?${params}`,
      {
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': process.env.BRAVE_SEARCH_API_KEY,
        },
        signal: AbortSignal.timeout(10000),
      }
    );

    if (!resp.ok) return null;
    const data = await resp.json();

    if (!data.web || !data.web.results) return null;

    for (const result of data.web.results) {
      const url = result.url;
      if (isRelevantUrl(url, eventInfo)) {
        const pageResult = await fetchPage(url);
        if (pageResult.success) {
          return { url, text: pageResult.text, method: 'brave-search' };
        }
      }
    }

    // Try first result even if domain doesn't match
    if (data.web.results.length > 0) {
      const url = data.web.results[0].url;
      const pageResult = await fetchPage(url);
      if (pageResult.success) {
        return { url, text: pageResult.text, method: 'brave-search' };
      }
    }

    return null;
  } catch {
    return null;
  }
}

async function googleSearch(query, eventInfo) {
  try {
    const params = new URLSearchParams({ q: query });
    const resp = await fetch(
      `https://www.google.com/search?${params}`,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'text/html',
        },
        signal: AbortSignal.timeout(10000),
      }
    );

    if (!resp.ok) return null;
    const html = await resp.text();

    // Extract URLs from Google results
    const urlPattern = /https?:\/\/[^\s"<>]+/g;
    const urls = html.match(urlPattern) || [];

    // Filter to relevant, non-Google URLs
    const candidateUrls = urls
      .filter(
        (u) =>
          !u.includes('google.com') &&
          !u.includes('googleapis.com') &&
          !u.includes('gstatic.com') &&
          !u.includes('schema.org') &&
          !u.includes('w3.org')
      )
      .filter((u, i, arr) => arr.indexOf(u) === i) // dedupe
      .slice(0, 5);

    // Prefer URLs matching known domain/org
    for (const url of candidateUrls) {
      if (isRelevantUrl(url, eventInfo)) {
        const pageResult = await fetchPage(url);
        if (pageResult.success) {
          return { url, text: pageResult.text, method: 'google-search' };
        }
      }
    }

    // Try first candidate
    if (candidateUrls.length > 0) {
      const pageResult = await fetchPage(candidateUrls[0]);
      if (pageResult.success) {
        return {
          url: candidateUrls[0],
          text: pageResult.text,
          method: 'google-search',
        };
      }
    }

    return null;
  } catch {
    return null;
  }
}

function isRelevantUrl(url, eventInfo) {
  const urlLower = url.toLowerCase();

  // Check if URL matches the event's known domain
  if (eventInfo.url) {
    try {
      const knownHost = new URL(eventInfo.url).hostname
        .replace('www.', '')
        .toLowerCase();
      if (urlLower.includes(knownHost)) return true;
    } catch {
      // Invalid URL in config
    }
  }

  // Check organizer name in URL
  if (eventInfo.organizer) {
    const orgLower = eventInfo.organizer.toLowerCase().replace(/\s+/g, '');
    if (urlLower.includes(orgLower)) return true;
  }

  // Check event name keywords in URL
  const nameWords = eventInfo.name
    .toLowerCase()
    .split(/[\s\/\-()]+/)
    .filter((w) => w.length > 3);
  const matchCount = nameWords.filter((w) => urlLower.includes(w)).length;
  if (matchCount >= 2) return true;

  return false;
}

module.exports = { discoverUrl };
