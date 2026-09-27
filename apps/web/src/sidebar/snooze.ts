// Adapted from pingdotgg/t3code packages/client-runtime/src/state/threadSettled.ts at 57a66608 (MIT).
// The snooze's preset times, as ms epoch for the host, and the custom time a
// person types into a datetime-local field.

const HOUR_MS = 60 * 60 * 1_000;
const EVENING_HOUR = 18;
const MORNING_HOUR = 9;

export type SnoozePresetId = "hour" | "three-hours" | "evening" | "tomorrow" | "next-week";

export interface SnoozePreset {
  readonly id: SnoozePresetId;
  readonly label: string;
  /** The time column beside the label, which complements it rather than repeating it: "Tomorrow" with "9:00 AM". */
  readonly whenLabel: string;
  readonly snoozedUntil: number;
}

function timeOfDayLabel(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function atHour(base: Date, hour: number): Date {
  const next = new Date(base);
  next.setHours(hour, 0, 0, 0);
  return next;
}

// Calendar days rather than 24 hours: a day across a clock change is 23 or 25 hours long.
function addDays(base: Date, days: number): Date {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return next;
}

/** The times a snooze offers. "This evening" only while evening is more than an hour off; on a Sunday "Tomorrow" and
 * "Next week" are the same Monday morning, so only "Tomorrow" is offered. */
export function resolveSnoozePresets(now: Date): ReadonlyArray<SnoozePreset> {
  const inAnHour = new Date(now.getTime() + HOUR_MS);
  const inThreeHours = new Date(now.getTime() + 3 * HOUR_MS);
  const presets: SnoozePreset[] = [
    { id: "hour", label: "In 1 hour", whenLabel: timeOfDayLabel(inAnHour), snoozedUntil: inAnHour.getTime() },
    { id: "three-hours", label: "In 3 hours", whenLabel: timeOfDayLabel(inThreeHours), snoozedUntil: inThreeHours.getTime() },
  ];
  const evening = atHour(now, EVENING_HOUR);
  if (evening.getTime() - now.getTime() > HOUR_MS) {
    presets.push({ id: "evening", label: "This evening", whenLabel: timeOfDayLabel(evening), snoozedUntil: evening.getTime() });
  }
  const tomorrow = atHour(addDays(now, 1), MORNING_HOUR);
  presets.push({ id: "tomorrow", label: "Tomorrow", whenLabel: timeOfDayLabel(tomorrow), snoozedUntil: tomorrow.getTime() });
  const daysUntilMonday = (1 - now.getDay() + 7) % 7 || 7;
  const nextWeek = atHour(addDays(now, daysUntilMonday), MORNING_HOUR);
  if (nextWeek.getTime() !== tomorrow.getTime()) {
    presets.push({
      id: "next-week",
      label: "Next week",
      whenLabel: `${nextWeek.toLocaleDateString(undefined, { weekday: "short" })} ${timeOfDayLabel(nextWeek)}`,
      snoozedUntil: nextWeek.getTime(),
    });
  }
  return presets;
}

/** The moment a datetime-local field's value names, read on this computer's clock, or null for a value that names
 * none or names a moment already past. */
export function resolveCustomSnooze(value: string, now: Date): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const at = new Date(value).getTime();
  return Number.isNaN(at) || at <= now.getTime() ? null : at;
}

/** The value a datetime-local field starts at: the given moment on this computer's clock, to the minute. */
export function datetimeLocalValue(at: number): string {
  const d = new Date(at);
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
}
