const cheerio = require('cheerio');
const robotsParser = require('robots-parser');

const USER_AGENT = 'EventWatch/1.0 (event-date-tracker)';
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const FETCH_TIMEOUT = 15000;

// Domains that block non-browser user agents or rely on JS rendering
const BROWSER_UA_DOMAINS = [
  'luma.com',
  'lu.ma',
  'stationdc.com',
  'stationdc.org',
  'crush26.com',
  'crush25.com',
];

function needsBrowserUA(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return BROWSER_UA_DOMAINS.some((d) => hostname.includes(d));
  } catch {
    return false;
  }
}

async function checkRobots(url) {
  try {
    const parsed = new URL(url);
    const robotsUrl = `${parsed.protocol}//${parsed.host}/robots.txt`;
    const resp = await fetch(robotsUrl, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return true; // No robots.txt = allowed
    const text = await resp.text();
    const robots = robotsParser(robotsUrl, text);
    return robots.isAllowed(url, USER_AGENT);
  } catch {
    return true; // On error, assume allowed
  }
}

async function fetchPage(url) {
  if (!url) return { success: false, error: 'No URL provided', text: null };

  const allowed = await checkRobots(url);
  if (!allowed) {
    return {
      success: false,
      error: `Blocked by robots.txt: ${url}`,
      text: null,
    };
  }

  try {
    const ua = needsBrowserUA(url) ? BROWSER_UA : USER_AGENT;
    const resp = await fetch(url, {
      headers: {
        'User-Agent': ua,
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
      redirect: 'follow',
    });

    if (!resp.ok) {
      return {
        success: false,
        error: `HTTP ${resp.status}: ${url}`,
        text: null,
      };
    }

    const html = await resp.text();
    const text = htmlToText(html);

    if (!text || text.trim().length < 50) {
      return {
        success: false,
        error: `Page content too short or empty: ${url}`,
        text: null,
      };
    }

    return { success: true, error: null, text };
  } catch (err) {
    return {
      success: false,
      error: `Fetch failed: ${err.message} (${url})`,
      text: null,
    };
  }
}

function htmlToText(html) {
  const $ = cheerio.load(html);

  // --- Extract structured data BEFORE stripping tags ---

  // 1. OG meta tags (present on most sites, even SPAs)
  const metaInfo = [];
  $('meta[property^="og:"], meta[name^="og:"], meta[property^="event:"], meta[name="description"]').each(function () {
    const prop = $(this).attr('property') || $(this).attr('name');
    const content = $(this).attr('content');
    if (prop && content) {
      metaInfo.push(`${prop}: ${content}`);
    }
  });

  // 2. JSON-LD structured data (Event schema, etc.)
  let jsonLdText = '';
  $('script[type="application/ld+json"]').each(function () {
    try {
      const json = JSON.parse($(this).text());
      const flat = flattenJsonLd(json);
      if (flat) jsonLdText += flat + '\n';
    } catch {
      // Not valid JSON-LD
    }
  });

  // 3. __NEXT_DATA__ for Next.js sites (e.g., Luma)
  let nextDataText = '';
  $('script#__NEXT_DATA__').each(function () {
    try {
      const json = JSON.parse($(this).text());
      nextDataText = extractNextDataText(json);
    } catch {
      // Not valid JSON
    }
  });

  // Remove script, style, nav, footer, header elements
  $('script, style, nav, footer, header, noscript, iframe, svg').remove();

  // Insert newlines around block-level elements to preserve structure
  $('p, div, br, h1, h2, h3, h4, h5, h6, li, tr, dt, dd, section, article').each(function () {
    $(this).prepend('\n');
    $(this).append('\n');
  });

  // Extract meaningful text
  const bodyText = $('body').text();

  // Assemble output: structured data first, then body text
  const parts = [];
  if (metaInfo.length > 0) {
    parts.push('--- Page Metadata ---');
    parts.push(metaInfo.join('\n'));
    parts.push('');
  }
  if (jsonLdText) {
    parts.push('--- Structured Event Data ---');
    parts.push(jsonLdText);
    parts.push('');
  }
  if (nextDataText) {
    parts.push('--- Page Data ---');
    parts.push(nextDataText);
    parts.push('');
  }
  parts.push(bodyText);

  // Clean up whitespace: collapse inline spaces, then collapse excess blank lines
  return parts
    .join('\n')
    .replace(/[^\S\n]+/g, ' ')       // collapse inline whitespace (preserve newlines)
    .replace(/\n{3,}/g, '\n\n')      // collapse 3+ newlines to 2
    .trim()
    .slice(0, 15000); // Limit to ~15k chars for Claude context
}

/**
 * Flatten JSON-LD into human-readable key-value text.
 * Focuses on Event-type schemas.
 */
function flattenJsonLd(json) {
  const items = Array.isArray(json) ? json : [json];
  const parts = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const type = item['@type'];
    if (type) parts.push(`type: ${type}`);
    for (const [key, val] of Object.entries(item)) {
      if (key.startsWith('@')) continue;
      if (typeof val === 'string' || typeof val === 'number') {
        parts.push(`${key}: ${val}`);
      } else if (val && typeof val === 'object' && !Array.isArray(val)) {
        // One level of nesting (e.g., location.name, location.address)
        for (const [k2, v2] of Object.entries(val)) {
          if (k2.startsWith('@')) continue;
          if (typeof v2 === 'string' || typeof v2 === 'number') {
            parts.push(`${key}.${k2}: ${v2}`);
          }
        }
      }
    }
  }
  return parts.length > 0 ? parts.join('\n') : '';
}

/**
 * Extract event-relevant text from Next.js __NEXT_DATA__ JSON.
 * Searches pageProps for date/event/time fields.
 */
function extractNextDataText(json) {
  try {
    const props = json.props?.pageProps || json.props || {};
    const text = JSON.stringify(props, null, 2);
    // Only include if it has event-like content and is meaningful
    const hasEventData =
      /\b(date|start|end|event|time|location|venue|address|timezone)\b/i.test(text);
    if (text.length > 50 && hasEventData) {
      return text.slice(0, 5000);
    }
  } catch {
    // Ignore parse errors
  }
  return '';
}

function tryYearIncrement(url) {
  if (!url) return null;
  const currentYear = new Date().getFullYear();
  const yearPattern = /\b(20\d{2})\b/;
  const match = url.match(yearPattern);
  if (!match) return null;

  const urlYear = parseInt(match[1], 10);
  if (urlYear >= currentYear) return null; // Already current or future

  // Jump directly to the current year (not just +1)
  return url.replace(match[1], String(currentYear));
}

module.exports = { fetchPage, htmlToText, tryYearIncrement, USER_AGENT };
