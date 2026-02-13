const cheerio = require('cheerio');
const robotsParser = require('robots-parser');

const USER_AGENT = 'EventWatch/1.0 (event-date-tracker)';
const FETCH_TIMEOUT = 15000;

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
    const resp = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
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

  // Remove script, style, nav, footer, header elements
  $('script, style, nav, footer, header, noscript, iframe, svg').remove();

  // Extract meaningful text
  const text = $('body').text();

  // Clean up whitespace
  return text
    .replace(/\s+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 15000); // Limit to ~15k chars for Claude context
}

function tryYearIncrement(url) {
  if (!url) return null;
  const currentYear = new Date().getFullYear();
  const yearPattern = /\b(20\d{2})\b/;
  const match = url.match(yearPattern);
  if (!match) return null;

  const urlYear = parseInt(match[1], 10);
  if (urlYear >= currentYear) return null; // Already current or future

  const nextYear = urlYear + 1;
  return url.replace(match[1], String(nextYear));
}

module.exports = { fetchPage, htmlToText, tryYearIncrement, USER_AGENT };
