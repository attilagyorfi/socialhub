import { DateTime } from "luxon";

const localMinuteFormat = "yyyy-LL-dd'T'HH:mm";

export function localDateTimeToUtc(value: string, timeZone: string) {
  const time = DateTime.fromISO(value, { zone: timeZone, setZone: true });
  if (!time.isValid || time.toFormat(localMinuteFormat) !== value.slice(0, 16))
    return {
      error: `That local time does not exist in ${timeZone} because of a daylight-saving change.`,
    };
  if (time.getPossibleOffsets().length > 1)
    return {
      error: `That local time occurs twice in ${timeZone}. Choose an unambiguous time.`,
    };
  return { iso: time.toUTC().toISO()! };
}

export function localInputValue(value: string, timeZone: string) {
  return DateTime.fromISO(value).setZone(timeZone).toFormat(localMinuteFormat);
}
