const DEFAULT_MAX_ENTRIES = 3000;
const MAX_STRING_LENGTH = 240;
const MAX_ARRAY_LENGTH = 10;
const MAX_OBJECT_KEYS = 12;
const MAX_DEPTH = 3;

function truncateString(value) {
  if (value.length <= MAX_STRING_LENGTH) {
    return value;
  }

  return `${value.slice(0, MAX_STRING_LENGTH - 3)}...`;
}

function sanitizeValue(value, depth = 0) {
  if (
    value === null
    || value === undefined
    || typeof value === "number"
    || typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "string") {
    return truncateString(value);
  }

  if (depth >= MAX_DEPTH) {
    return "[truncated]";
  }

  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_LENGTH).map((item) => sanitizeValue(item, depth + 1));
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, MAX_OBJECT_KEYS)
        .map(([key, item]) => [key, sanitizeValue(item, depth + 1)])
    );
  }

  return String(value);
}

export class DiagnosticsBuffer {
  constructor(maxEntries = DEFAULT_MAX_ENTRIES) {
    this.maxEntries = maxEntries;
    this.entries = [];
    this.nextId = 1;
  }

  record(type, detail = {}) {
    const entry = {
      id: this.nextId,
      time: new Date().toISOString(),
      type: String(type || "event"),
      detail: sanitizeValue(detail, 0) || {},
    };

    this.nextId += 1;
    this.entries.push(entry);

    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }

    return entry;
  }

  list(limit = 100) {
    const normalizedLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(this.maxEntries, Math.trunc(limit)))
      : 100;

    return this.entries.slice(-normalizedLimit);
  }

  get count() {
    return this.entries.length;
  }
}
