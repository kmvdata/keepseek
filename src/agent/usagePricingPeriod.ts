export type PricingPeriod = 'offPeak' | 'peak';

/** DeepSeek pricing windows use Beijing wall time, independent of host TZ. */
export function getPricingPeriod(date: Date = new Date()): PricingPeriod {
  const beijingTime = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const beijingDay = beijingTime.getUTCDay();
  const beijingHour = beijingTime.getUTCHours();
  const isWeekday = beijingDay >= 1 && beijingDay <= 5;
  const isPeak = isWeekday && (
    (beijingHour >= 9 && beijingHour < 12) ||
    (beijingHour >= 14 && beijingHour < 18)
  );
  return isPeak ? 'peak' : 'offPeak';
}
