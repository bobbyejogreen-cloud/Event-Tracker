#!/usr/bin/env node

require('dotenv').config();

const { Command } = require('commander');
const Table = require('cli-table3');
const config = require('./lib/config');
const { fetchPage } = require('./lib/scraper');
const { extractEventDates } = require('./lib/extractor');
const { upsertCalendarEvent, deleteCalendarEvent, purgeAllEvents, ensureCalendar } = require('./lib/calendar');
const { authorize } = require('./lib/auth');
const { discoverUrl } = require('./lib/search');

const program = new Command();

program
  .name('event-watch')
  .description(
    'Monitor industry event websites for date announcements and sync with Google Calendar'
  )
  .version('1.0.0');

// ─── CHECK COMMAND ──────────────────────────────────────────────────────────

program
  .command('check')
  .description('Check events for date changes and update calendar')
  .option('--dry-run', 'Print what would happen without making changes')
  .option('--resync', 'Force recreate all calendar events (use after switching calendars)')
  .option('--tag <tag>', 'Only check events with a specific tag')
  .option('--month <month>', 'Only check events in a specific typical month')
  .action(async (opts) => {
    try {
      const cfg = config.load();
      let events = cfg.events;

      if (opts.tag) {
        events = config.filterByTag(cfg, opts.tag);
        console.log(`Filtering by tag: ${opts.tag} (${events.length} events)\n`);
      }
      if (opts.month) {
        events = opts.tag
          ? events.filter(
              (e) =>
                e.typical_month &&
                e.typical_month.toLowerCase() === opts.month.toLowerCase()
            )
          : config.filterByMonth(cfg, opts.month);
        console.log(
          `Filtering by month: ${opts.month} (${events.length} events)\n`
        );
      }

      if (events.length === 0) {
        console.log('No events matched the filters.');
        return;
      }

      // Authorize Google Calendar (unless dry-run)
      let auth = null;
      if (!opts.dryRun) {
        try {
          auth = await authorize();
          // Always ensure we're using the dedicated Event Watch calendar
          try {
            const calendarId = await ensureCalendar(auth, 'Event Watch');
            if (cfg.google_calendar_id !== calendarId) {
              console.log(`Switching to dedicated calendar: Event Watch (${calendarId})`);
              cfg.google_calendar_id = calendarId;
              // Force resync when calendar changes so events get created in the right place
              if (!opts.resync) {
                console.log('  Calendar changed — enabling resync automatically.\n');
                opts.resync = true;
              }
              // Save calendar ID immediately so it persists
              config.save(cfg);
            }
          } catch (calErr) {
            console.warn(`Could not find/create dedicated calendar: ${calErr.message}`);
            if (cfg.google_calendar_id === 'primary') {
              console.warn('Events will be added to your primary calendar.\n');
            }
          }
        } catch (err) {
          console.error(`Google Calendar auth failed: ${err.message}`);
          console.error('Continuing in dry-run mode...\n');
          opts.dryRun = true;
        }
      }

      // Resync: delete old calendar events, then clear IDs to force recreation
      if (opts.resync) {
        console.log('RESYNC: Deleting old calendar events before recreation...');
        let deleted = 0;
        for (const ev of cfg.events) {
          if (ev.calendar_event_id && auth && !opts.dryRun) {
            try {
              await deleteCalendarEvent(auth, cfg.google_calendar_id, ev.calendar_event_id);
              deleted++;
            } catch (err) {
              console.log(`  Could not delete calendar event for "${ev.name}": ${err.message}`);
            }
          }
          ev.calendar_event_id = null;
        }
        config.save(cfg);
        if (!opts.dryRun) {
          console.log(`  Deleted ${deleted} old calendar events.`);
        }
        console.log('  All calendar event IDs cleared.\n');
      }

      if (opts.dryRun) {
        console.log('=== DRY RUN MODE ===\n');
      }

      const summary = { checked: 0, updated: 0, created: 0, errors: 0, unchanged: 0, notFound: 0 };

      for (const event of events) {
        console.log(`[${summary.checked + 1}/${events.length}] ${event.name}`);
        summary.checked++;

        try {
          // Step 1: Fetch the page
          let pageResult = await fetchPage(event.url);

          // Step 2: Fallback if fetch failed or no URL
          if (!pageResult.success) {
            if (pageResult.error) {
              console.log(`  ${pageResult.error}`);
            }
            console.log('  Attempting fallback URL discovery...');
            const discovered = await discoverUrl(event);
            if (discovered) {
              pageResult = { success: true, text: discovered.text };
              const oldUrl = event.url;
              // Update URL in config
              const cfgEvent = config.findEvent(cfg, event.name);
              if (cfgEvent && discovered.url !== event.url) {
                cfgEvent.url = discovered.url;
                console.log(
                  `  URL updated: ${oldUrl || 'null'} → ${discovered.url} (via ${discovered.method})`
                );
              }
            } else {
              console.log('  All fallback attempts failed, skipping.');
              summary.errors++;
              config.save(cfg);
              console.log();
              continue;
            }
          }

          // Step 3: Extract dates with Claude
          console.log('  Extracting dates with Claude...');
          const extracted = await extractEventDates(pageResult.text, event);

          if (extracted.confidence === 'not_found') {
            console.log('  No dates found (confidence: not_found)');
            const cfgEvent = config.findEvent(cfg, event.name);
            if (cfgEvent) {
              cfgEvent.last_checked = new Date().toISOString();
            }
            summary.notFound++;
            config.save(cfg);
            console.log();
            continue;
          }

          console.log(
            `  Found: ${extracted.start_date} to ${extracted.end_date} (${extracted.confidence})`
          );
          if (extracted.location) {
            console.log(`  Location: ${extracted.location}`);
          }

          // Step 4: Compare with last known
          const cfgEvent = config.findEvent(cfg, event.name);
          const datesChanged = haveDatesChanged(cfgEvent.last_known, extracted);
          const needsCalendarSync = !cfgEvent.calendar_event_id;

          if (datesChanged) {
            console.log(
              `  DATES CHANGED: ${formatDateRange(cfgEvent.last_known)} → ${extracted.start_date} to ${extracted.end_date}`
            );
          } else if (needsCalendarSync) {
            console.log('  Dates unchanged, but no calendar event exists — syncing.');
          }

          if (datesChanged || needsCalendarSync) {
            // Step 5: Update/create calendar event
            if (!opts.dryRun && auth) {
              try {
                const calEventId = await upsertCalendarEvent(
                  auth,
                  cfg.google_calendar_id,
                  cfgEvent,
                  extracted,
                  cfgEvent.calendar_event_id
                );
                cfgEvent.calendar_event_id = calEventId;
                if (datesChanged && cfgEvent.last_known) {
                  console.log(`  Calendar event UPDATED: ${calEventId}`);
                  summary.updated++;
                } else {
                  console.log(`  Calendar event CREATED: ${calEventId}`);
                  summary.created++;
                }
              } catch (calErr) {
                console.error(`  Calendar error: ${calErr.message}`);
                summary.errors++;
              }
            } else {
              if (datesChanged && cfgEvent.last_known) {
                console.log('  [DRY RUN] Would UPDATE calendar event');
                summary.updated++;
              } else {
                console.log('  [DRY RUN] Would CREATE calendar event');
                summary.created++;
              }
            }

            // Update config with new dates
            if (datesChanged) {
              cfgEvent.last_known = {
                start: extracted.start_date,
                end: extracted.end_date,
              };
            }
          } else {
            console.log('  Dates unchanged');
            summary.unchanged++;
          }

          // Update last_checked
          cfgEvent.last_checked = new Date().toISOString();
        } catch (err) {
          console.error(`  Error: ${err.message}`);
          summary.errors++;
        }

        // Save config after each event so progress survives interruptions
        config.save(cfg);
        console.log();
      }

      // Final save with global timestamp
      cfg.last_global_check = new Date().toISOString();
      config.save(cfg);

      // Print summary
      console.log('='.repeat(50));
      console.log('SUMMARY');
      console.log('='.repeat(50));
      console.log(`Checked:   ${summary.checked}`);
      console.log(`Created:   ${summary.created}`);
      console.log(`Updated:   ${summary.updated}`);
      console.log(`Unchanged: ${summary.unchanged}`);
      console.log(`Not found: ${summary.notFound}`);
      console.log(`Errors:    ${summary.errors}`);

      if (opts.dryRun) {
        console.log('\n(Dry run — no calendar changes were made)');
      }
    } catch (err) {
      console.error(`Fatal error: ${err.message}`);
      process.exit(1);
    }
  });

// ─── LIST COMMAND ───────────────────────────────────────────────────────────

program
  .command('list')
  .description('Show all tracked events')
  .option('--tag <tag>', 'Filter by tag')
  .option('--missing-url', 'Show only events without URLs')
  .action((opts) => {
    const cfg = config.load();
    let events = cfg.events;

    if (opts.tag) {
      events = config.filterByTag(cfg, opts.tag);
    }
    if (opts.missingUrl) {
      events = events.filter((e) => !e.url);
    }

    if (events.length === 0) {
      console.log('No events matched the filters.');
      return;
    }

    const table = new Table({
      head: ['Name', 'Month', 'Location', 'Dates', 'URL', 'Last Checked'],
      colWidths: [35, 10, 18, 24, 6, 22],
      wordWrap: true,
    });

    // Sort by typical month order
    const monthOrder = [
      'january', 'february', 'march', 'april', 'may', 'june',
      'july', 'august', 'september', 'october', 'november', 'december',
    ];
    events.sort((a, b) => {
      const aIdx = monthOrder.indexOf((a.typical_month || '').toLowerCase());
      const bIdx = monthOrder.indexOf((b.typical_month || '').toLowerCase());
      return aIdx - bIdx;
    });

    for (const event of events) {
      const dates = event.last_known
        ? `${event.last_known.start} → ${event.last_known.end}`
        : '—';
      const hasUrl = event.url ? 'Yes' : 'No';
      const lastChecked = event.last_checked
        ? new Date(event.last_checked).toLocaleDateString()
        : '—';

      table.push([
        event.name,
        event.typical_month || '—',
        event.typical_location || '—',
        dates,
        hasUrl,
        lastChecked,
      ]);
    }

    console.log(`\nTracked Events (${events.length}):\n`);
    console.log(table.toString());

    // Tag summary
    const allTags = new Set();
    events.forEach((e) => e.tags.forEach((t) => allTags.add(t)));
    console.log(`\nTags: ${[...allTags].sort().join(', ')}`);

    const missingUrlCount = events.filter((e) => !e.url).length;
    const missingDatesCount = events.filter((e) => !e.last_known).length;
    console.log(`Missing URLs: ${missingUrlCount}`);
    console.log(`Missing dates: ${missingDatesCount}`);
  });

// ─── ADD COMMAND ────────────────────────────────────────────────────────────

program
  .command('add')
  .description('Add a new event to track')
  .requiredOption('--name <name>', 'Event name')
  .option('--url <url>', 'Event URL')
  .option('--tags <tags>', 'Comma-separated tags')
  .option('--month <month>', 'Typical month (e.g., "March")')
  .option('--location <location>', 'Typical location')
  .option('--organizer <organizer>', 'Event organizer')
  .option('--notes <notes>', 'Additional notes')
  .action((opts) => {
    try {
      const cfg = config.load();
      config.addEvent(cfg, {
        name: opts.name,
        url: opts.url || null,
        tags: opts.tags ? opts.tags.split(',').map((t) => t.trim()) : [],
        typical_month: opts.month || null,
        typical_location: opts.location || null,
        organizer: opts.organizer || null,
        notes: opts.notes || null,
      });
      console.log(`Added: "${opts.name}"`);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

// ─── REMOVE COMMAND ─────────────────────────────────────────────────────────

program
  .command('remove')
  .description('Remove an event from tracking')
  .requiredOption('--name <name>', 'Event name to remove')
  .action((opts) => {
    try {
      const cfg = config.load();
      const removed = config.removeEvent(cfg, opts.name);
      console.log(`Removed: "${removed.name}"`);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

// ─── INIT COMMAND ──────────────────────────────────────────────────────────

program
  .command('init')
  .description('Create a dedicated Google Calendar for event tracking')
  .option('--name <name>', 'Calendar name', 'Event Watch')
  .action(async (opts) => {
    try {
      const auth = await authorize();
      console.log(`Creating/finding calendar "${opts.name}"...`);
      const calendarId = await ensureCalendar(auth, opts.name);

      const cfg = config.load();
      cfg.google_calendar_id = calendarId;
      config.save(cfg);

      console.log(`Calendar ready: "${opts.name}"`);
      console.log(`Calendar ID saved to events.json: ${calendarId}`);
      console.log('\nAll future events will be added to this calendar.');
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

// ─── PURGE COMMAND ─────────────────────────────────────────────────────────

program
  .command('purge')
  .description('Delete ALL event-watch events from Google Calendar and reset tracking')
  .action(async () => {
    try {
      const auth = await authorize();
      const cfg = config.load();
      const calendarId = cfg.google_calendar_id || 'primary';

      console.log('Purging all event-watch events from Google Calendar...\n');
      const deleted = await purgeAllEvents(auth, calendarId);
      console.log(`\nDeleted ${deleted} events from Google Calendar.`);

      // Clear all calendar_event_ids in config
      for (const ev of cfg.events) {
        ev.calendar_event_id = null;
      }
      config.save(cfg);
      console.log('Cleared all calendar event IDs in events.json.');
      console.log('\nRun "node event-watch.js check" to recreate events cleanly.');
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

// ─── HELPERS ────────────────────────────────────────────────────────────────

function haveDatesChanged(lastKnown, extracted) {
  if (!extracted.start_date) return false;
  if (!lastKnown) return true;
  return (
    lastKnown.start !== extracted.start_date ||
    lastKnown.end !== extracted.end_date
  );
}

function formatDateRange(lastKnown) {
  if (!lastKnown) return 'none';
  return `${lastKnown.start} to ${lastKnown.end}`;
}

program.parse();
