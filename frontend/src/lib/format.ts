const MINUS = "−";

function typographic(text: string): string {
  if (!text.startsWith("-")) return text;
  return Number(text) === 0 ? text.slice(1) : MINUS + text.slice(1);
}

export function fixed(value: number, digits: number): string {
  return typographic(value.toFixed(digits));
}

export function significant(value: number, digits: number): string {
  return typographic(value.toPrecision(digits));
}

const plainNumber = new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 });
const smallNumber = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 3 });

export function plain(value: number): string {
  if (value !== 0 && Math.abs(value) < 0.000001) return significant(value, 3);
  return typographic((value !== 0 && Math.abs(value) < 0.001 ? smallNumber : plainNumber).format(value));
}

export function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

export function count(value: number, word: string): string {
  return `${value} ${plural(value, word)}`;
}

/** API units are ASCII ("uM", "C"); show them the way a lab writes them. */
export function unit(raw: string | null | undefined): string {
  if (!raw) return "";
  if (raw === "C") return "°C";
  return raw.replace(/\bu(?=(M|L|g|mol|m)\b)/g, "µ");
}

export function quantity(value: number | null | undefined, rawUnit: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = unit(rawUnit);
  return text ? `${plain(value)} ${text}` : plain(value);
}

/** Several concentrations read as "0.5, 1, 5 µM" when they share a unit. */
export function quantities(values: readonly { value: number; unit?: string | null }[]): string | null {
  if (values.length === 0) return null;
  if (new Set(values.map((q) => q.unit ?? "")).size > 1) {
    return values.map((q) => quantity(q.value, q.unit)).join(", ");
  }
  const text = unit(values[0]?.unit);
  const numbers = values.map((q) => plain(q.value)).join(", ");
  return text ? `${numbers} ${text}` : numbers;
}

export function temperature(celsius: number | null | undefined): string | null {
  return celsius === null || celsius === undefined ? null : `${plain(celsius)} °C`;
}

export function humanize(identifier: string): string {
  const spaced = identifier.replaceAll("_", " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Day, short month, year ("5 Nov 2026"): unambiguous across US and European readers. Built by hand
 * because locale data varies ("Sept" in some en-GB builds). */
function dayMonthYear(day: number, monthIndex: number, year: number): string {
  return `${day} ${MONTHS[monthIndex] ?? "?"} ${year}`;
}

/** Calendar dates arrive as "YYYY-MM-DD". `new Date(iso)` reads them as UTC midnight, which shows the
 * previous day west of Greenwich, so build the local date from its parts. */
export function date(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return iso;
  const [, year, month, day] = match;
  return dayMonthYear(Number(day), Number(month) - 1, Number(year));
}

export function dateTime(iso: string): string {
  const moment = new Date(iso);
  const time = `${String(moment.getHours()).padStart(2, "0")}:${String(moment.getMinutes()).padStart(2, "0")}`;
  return `${dayMonthYear(moment.getDate(), moment.getMonth(), moment.getFullYear())}, ${time}`;
}

export function daysLeft(days: number): string {
  if (days < 0) return `expired ${count(-days, "day")} ago`;
  if (days === 0) return "expires today";
  return `${count(days, "day")} left`;
}
