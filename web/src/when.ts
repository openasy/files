// Dates in the page's language: "13 Nov", or "13 Nov, 17:30" with the time.
import { useLocalePreference } from "@openasy/ui";
import { useCallback } from "react";

export function useDate() {
  const [locale] = useLocalePreference();
  return useCallback(
    (iso: string, time = false) =>
      new Date(iso).toLocaleString(locale, {
        day: "numeric",
        month: "short",
        ...(time && { hour: "2-digit", minute: "2-digit" }),
        ...(!time && { timeZone: "UTC" }),
      }),
    [locale],
  );
}

/** Whole days from now until a date, rounded down; negative once it is past. */
export const daysLeft = (iso: string, now = Date.now()) => Math.floor((Date.parse(iso) - now) / 86_400_000);
