const { google } = require('googleapis');

// Google Calendar color IDs:
// 1=Lavender, 2=Sage, 3=Grape, 4=Flamingo, 5=Banana,
// 6=Tangerine, 7=Peacock, 8=Graphite, 9=Blueberry, 10=Basil, 11=Tomato
const EVENT_COLOR_ID = '3'; // Grape

function buildEventBody(eventInfo, extracted) {
  const descriptionParts = [];

  if (eventInfo.url) {
    descriptionParts.push(`Source: ${eventInfo.url}`);
  }
  if (eventInfo.organizer) {
    descriptionParts.push(`Organizer: ${eventInfo.organizer}`);
  }
  if (eventInfo.tags && eventInfo.tags.length > 0) {
    descriptionParts.push(`Tags: ${eventInfo.tags.join(', ')}`);
  }
  if (extracted.registration_url) {
    descriptionParts.push(`Registration: ${extracted.registration_url}`);
  }
  if (extracted.confidence) {
    descriptionParts.push(`Date confidence: ${extracted.confidence}`);
  }
  if (extracted.raw_excerpt) {
    descriptionParts.push(`\nExcerpt: "${extracted.raw_excerpt}"`);
  }
  if (eventInfo.notes) {
    descriptionParts.push(`\nNotes: ${eventInfo.notes}`);
  }
  descriptionParts.push(`\n---\nManaged by event-watch`);

  const location =
    extracted.venue && extracted.city
      ? `${extracted.venue}, ${extracted.city}`
      : extracted.location ||
        extracted.city ||
        extracted.venue ||
        eventInfo.typical_location ||
        null;

  // Use dateTime for single-day events with specific times, otherwise all-day
  const isSingleDay = extracted.start_date === (extracted.end_date || extracted.start_date);
  const hasTime = isSingleDay && extracted.start_time;
  const tz = extracted.timezone || 'America/New_York';

  let start, end;
  if (hasTime) {
    start = { dateTime: `${extracted.start_date}T${extracted.start_time}:00`, timeZone: tz };
    const endTime = extracted.end_time || extracted.start_time;
    end = { dateTime: `${extracted.start_date}T${endTime}:00`, timeZone: tz };
  } else {
    start = { date: extracted.start_date };
    // Google Calendar end date is exclusive, so add 1 day
    end = { date: addOneDay(extracted.end_date || extracted.start_date) };
  }

  return {
    summary: eventInfo.name,
    location: location,
    description: descriptionParts.join('\n'),
    start,
    end,
    colorId: EVENT_COLOR_ID,
    transparency: 'transparent', // Show as "free" — these are context events, not time blocks
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'email', minutes: 60480 }, // 6 weeks = 42 days
        { method: 'popup', minutes: 20160 }, // 2 weeks = 14 days
      ],
    },
  };
}

function addOneDay(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + 1);
  return d.toISOString().split('T')[0];
}

async function createCalendarEvent(auth, calendarId, eventInfo, extracted) {
  const calendar = google.calendar({ version: 'v3', auth });
  const body = buildEventBody(eventInfo, extracted);

  const res = await calendar.events.insert({
    calendarId: calendarId,
    resource: body,
  });

  return res.data.id;
}

async function updateCalendarEvent(
  auth,
  calendarId,
  calendarEventId,
  eventInfo,
  extracted
) {
  const calendar = google.calendar({ version: 'v3', auth });
  const body = buildEventBody(eventInfo, extracted);

  await calendar.events.update({
    calendarId: calendarId,
    eventId: calendarEventId,
    resource: body,
  });

  return calendarEventId;
}

async function upsertCalendarEvent(
  auth,
  calendarId,
  eventInfo,
  extracted,
  existingCalendarEventId
) {
  if (!extracted.start_date) {
    throw new Error('No start date to create calendar event');
  }

  try {
    if (existingCalendarEventId) {
      // Verify the event still exists before updating
      const calendar = google.calendar({ version: 'v3', auth });
      try {
        await calendar.events.get({
          calendarId: calendarId,
          eventId: existingCalendarEventId,
        });
        return await updateCalendarEvent(
          auth,
          calendarId,
          existingCalendarEventId,
          eventInfo,
          extracted
        );
      } catch (getErr) {
        // Event was deleted, create a new one
        if (getErr.code === 404 || getErr.status === 404) {
          return await createCalendarEvent(
            auth,
            calendarId,
            eventInfo,
            extracted
          );
        }
        throw getErr;
      }
    }
    return await createCalendarEvent(auth, calendarId, eventInfo, extracted);
  } catch (err) {
    throw new Error(`Calendar API error: ${err.message}`);
  }
}

async function ensureCalendar(auth, calendarName = 'Event Watch') {
  const calendar = google.calendar({ version: 'v3', auth });

  // Check if a calendar with this name already exists (paginated)
  let pageToken;
  do {
    const listRes = await calendar.calendarList.list({
      maxResults: 250,
      pageToken,
    });
    const existing = (listRes.data.items || []).find(
      (cal) => cal.summary === calendarName
    );
    if (existing) {
      return existing.id;
    }
    pageToken = listRes.data.nextPageToken;
  } while (pageToken);

  // Create a new calendar
  const createRes = await calendar.calendars.insert({
    resource: { summary: calendarName },
  });

  return createRes.data.id;
}

module.exports = { upsertCalendarEvent, createCalendarEvent, updateCalendarEvent, ensureCalendar };
