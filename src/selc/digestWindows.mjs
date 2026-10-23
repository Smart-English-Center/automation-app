const DEFAULT_TIMEZONE = "UTC";
const DEFAULT_OFFSET = "+00:00";

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday"
];

function clean_(value) {
  return String(value ?? "").trim();
}

function normaliseTimestamp_(value, label) {
  if (value === undefined || value === null || value === "") return "";

  const parsed = value instanceof Date
    ? new Date(value.getTime())
    : new Date(clean_(value));

  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ${label} timestamp: ${clean_(value)}`);
  }

  return parsed.toISOString();
}

function timezone_() {
  return clean_(process.env.SCHEDULER_TIMEZONE || process.env.TZ) || DEFAULT_TIMEZONE;
}

function offset_() {
  return clean_(process.env.JEA_LOCAL_TIMEZONE_OFFSET || process.env.LOCAL_TIMEZONE_OFFSET) || DEFAULT_OFFSET;
}

function getLocalDateString_(timeZone = timezone_()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function parseYmdAsUtc_(value) {
  const clean = clean_(value).slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clean);
  if (!match) throw new Error(`Invalid date. Expected YYYY-MM-DD, received: ${value}`);
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (date.toISOString().slice(0, 10) !== clean) {
    throw new Error(`Invalid calendar date: ${value}`);
  }
  return date;
}

function addUtcDays_(date, days) {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function ymd_(date) {
  return date.toISOString().slice(0, 10);
}

function localStamp_(date, time = "00:00:00") {
  return `${ymd_(date)}T${time}${offset_()}`;
}

function localDateFromTimestamp_(value) {
  const source = clean_(value);
  if (!source) return "";
  const instant = new Date(source);
  if (Number.isNaN(instant.getTime())) return source.slice(0, 10);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone_(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(instant);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function longDate_(date, locale = "en-GB") {
  return new Intl.DateTimeFormat(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC"
  }).format(date);
}

function monthKey_(dateString) {
  return clean_(dateString).slice(0, 7);
}

export function resolveCycleDate(value) {
  return clean_(value).slice(0, 10) || getLocalDateString_();
}

export function buildTeacherDigestWindow(options = {}) {
  const cycleDate = resolveCycleDate(options.cycleDate || options.cycle_date || process.env.TEACHER_DIGEST_CYCLE_DATE);
  const cycle = parseYmdAsUtc_(cycleDate);
  const dayIndex = cycle.getUTCDay();
  const cycleDay = DAY_NAMES[dayIndex].toUpperCase();
  let start;
  let endExclusive;
  let mode = "NOT_A_DIGEST_DAY";
  let shouldRun = false;

  if (dayIndex === 3) {
    shouldRun = true;
    start = addUtcDays_(cycle, -3);
    endExclusive = cycle;
    mode = "SUNDAY_MONDAY_TUESDAY";
  } else if (dayIndex === 5) {
    shouldRun = true;
    start = addUtcDays_(cycle, -2);
    endExclusive = cycle;
    mode = "WEDNESDAY_THURSDAY";
  } else if (dayIndex === 0) {
    shouldRun = true;
    start = addUtcDays_(cycle, -2);
    endExclusive = cycle;
    mode = "FRIDAY_SATURDAY";
  }

  const includedDates = shouldRun
    ? Array.from({ length: Math.max(0, Math.round((endExclusive - start) / 86400000)) }, (_, index) => addUtcDays_(start, index))
    : [];

  const windowDaysAndDates = includedDates.length === 0
    ? ""
    : joinHumanList_(includedDates.map((date) => longDate_(date)));

  const windowDaysAndDatesFr = includedDates.length === 0
    ? ""
    : joinHumanList_(includedDates.map((date) => longDate_(date, "fr-FR")), "fr-FR");

  const lastIncludedDate = shouldRun ? addUtcDays_(endExclusive, -1) : null;
  const windowRangeEn = shouldRun
    ? `from ${longDate_(start)} to ${longDate_(lastIncludedDate)}`
    : "";
  const windowRangeFr = shouldRun
    ? `du ${longDate_(start, "fr-FR")} au ${longDate_(lastIncludedDate, "fr-FR")}`
    : "";

  return {
    cycle_type: "TEACHER_PROGRESS_DIGEST",
    cycle_date: cycleDate,
    cycle_day: cycleDay,
    cycle_key: `teacher-digest:${cycleDate}:${cycleDay}`,
    should_run: shouldRun,
    window_mode: mode,
    activity_window_start: shouldRun ? localStamp_(start, "00:00:00") : "",
    activity_window_end_exclusive: shouldRun ? localStamp_(endExclusive, "00:00:00") : "",
    feedback_window_start: shouldRun ? localStamp_(cycle, "00:00:00") : "",
    feedback_window_end_exclusive: shouldRun ? localStamp_(cycle, "23:59:59") : "",
    window_start: shouldRun ? ymd_(start) : "",
    window_end: shouldRun ? ymd_(addUtcDays_(endExclusive, -1)) : "",
    window_days_and_dates: windowDaysAndDates,
    window_days_and_dates_fr: windowDaysAndDatesFr,
    window_range_en: windowRangeEn,
    window_range_fr: windowRangeFr,
    included_dates: includedDates.map(ymd_),
    timezone: timezone_(),
    local_timezone_offset: offset_()
  };
}

export function applyTeacherDigestCatchUpWindow(window, options = {}) {
  if (!window?.should_run) return { ...window };

  const nominalStart = normaliseTimestamp_(window.activity_window_start, "nominal activity-window start");
  const currentEnd = normaliseTimestamp_(window.activity_window_end_exclusive, "activity-window end");
  const previousActivityEnd = normaliseTimestamp_(
    options.previousActivityEnd || options.previous_activity_end,
    "previous activity-window end"
  );
  const previousDigestSentAt = normaliseTimestamp_(
    options.previousDigestSentAt || options.previous_digest_sent_at,
    "previous digest checkpoint"
  );
  const snapshotAt = normaliseTimestamp_(
    options.snapshotAt || options.snapshot_at || new Date(),
    "digest snapshot"
  );
  const validPreviousEnd = previousActivityEnd && Date.parse(previousActivityEnd) < Date.parse(currentEnd)
    ? previousActivityEnd
    : "";
  const activityStart = validPreviousEnd || nominalStart;
  const startDate = localDateFromTimestamp_(activityStart);
  const endExclusiveDate = localDateFromTimestamp_(currentEnd);
  const lastIncludedDate = addUtcDays_(parseYmdAsUtc_(endExclusiveDate), -1);
  const start = parseYmdAsUtc_(startDate);
  const includedDates = [];
  for (let cursor = start; cursor < parseYmdAsUtc_(endExclusiveDate); cursor = addUtcDays_(cursor, 1)) {
    includedDates.push(cursor);
  }

  return {
    ...window,
    activity_window_start: activityStart,
    activity_window_end_exclusive: currentEnd,
    feedback_window_start: previousDigestSentAt || activityStart,
    feedback_window_end_exclusive: snapshotAt,
    window_start: startDate,
    window_end: ymd_(lastIncludedDate),
    window_days_and_dates: joinHumanList_(includedDates.map((date) => longDate_(date))),
    window_days_and_dates_fr: joinHumanList_(includedDates.map((date) => longDate_(date, "fr-FR")), "fr-FR"),
    window_range_en: `from ${longDate_(start)} to ${longDate_(lastIncludedDate)}`,
    window_range_fr: `du ${longDate_(start, "fr-FR")} au ${longDate_(lastIncludedDate, "fr-FR")}`,
    included_dates: includedDates.map(ymd_),
    nominal_activity_window_start: nominalStart,
    catch_up_applied: Boolean(validPreviousEnd && validPreviousEnd !== nominalStart),
    previous_feedback_checkpoint_at: previousDigestSentAt || "",
    snapshot_at: snapshotAt
  };
}

export function buildMonthlyCycle(options = {}) {
  const cycleDate = resolveCycleDate(options.cycleDate || options.cycle_date);
  return {
    cycle_date: cycleDate,
    cycle_key: monthKey_(cycleDate),
    cycle_month: monthKey_(cycleDate)
  };
}

function joinHumanList_(items, locale = "en-GB") {
  if (!items.length) return "";
  const conjunction = locale.toLowerCase().startsWith("fr") ? "et" : "and";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} ${conjunction} ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, ${conjunction} ${items[items.length - 1]}`;
}
