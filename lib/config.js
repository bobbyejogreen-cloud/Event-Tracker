const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'events.json');

function load() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return { google_calendar_id: 'primary', last_global_check: null, events: [] };
  }
  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  return JSON.parse(raw);
}

function save(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

function findEvent(config, name) {
  return config.events.find(
    (e) => e.name.toLowerCase() === name.toLowerCase()
  );
}

function addEvent(config, eventData) {
  const existing = findEvent(config, eventData.name);
  if (existing) {
    throw new Error(`Event "${eventData.name}" already exists`);
  }
  config.events.push({
    name: eventData.name,
    url: eventData.url || null,
    tags: eventData.tags || [],
    typical_month: eventData.typical_month || null,
    typical_location: eventData.typical_location || null,
    organizer: eventData.organizer || null,
    last_known: null,
    last_checked: null,
    calendar_event_id: null,
    notes: eventData.notes || null,
  });
  save(config);
  return config;
}

function removeEvent(config, name) {
  const idx = config.events.findIndex(
    (e) => e.name.toLowerCase() === name.toLowerCase()
  );
  if (idx === -1) {
    throw new Error(`Event "${name}" not found`);
  }
  const removed = config.events.splice(idx, 1)[0];
  save(config);
  return removed;
}

function updateEvent(config, name, updates) {
  const event = findEvent(config, name);
  if (!event) {
    throw new Error(`Event "${name}" not found`);
  }
  Object.assign(event, updates);
  save(config);
  return event;
}

function filterByTag(config, tag) {
  return config.events.filter((e) =>
    e.tags.some((t) => t.toLowerCase() === tag.toLowerCase())
  );
}

function filterByMonth(config, month) {
  return config.events.filter(
    (e) =>
      e.typical_month &&
      e.typical_month.toLowerCase() === month.toLowerCase()
  );
}

function filterMissingUrl(config) {
  return config.events.filter((e) => !e.url);
}

module.exports = {
  load,
  save,
  findEvent,
  addEvent,
  removeEvent,
  updateEvent,
  filterByTag,
  filterByMonth,
  filterMissingUrl,
};
