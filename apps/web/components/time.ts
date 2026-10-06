import { DateTime } from "luxon";
import { currentLocale, translate, type Locale } from "../i18n/core";

const localMinuteFormat = "yyyy-LL-dd'T'HH:mm";

export function localDateTimeToUtc(
  value: string,
  timeZone: string,
  locale: Locale = currentLocale(),
) {
  const time = DateTime.fromISO(value, { zone: timeZone, setZone: true });
  if (!time.isValid || time.toFormat(localMinuteFormat) !== value.slice(0, 16))
    return {
      error: translate(locale, "calendar.error.timeMissing", { timeZone }),
    };
  if (time.getPossibleOffsets().length > 1)
    return {
      error: translate(locale, "calendar.error.timeAmbiguous", { timeZone }),
    };
  return { iso: time.toUTC().toISO()! };
}

export function localInputValue(value: string, timeZone: string) {
  return DateTime.fromISO(value).setZone(timeZone).toFormat(localMinuteFormat);
}
