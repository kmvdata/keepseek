export type PricingPeriod = 'offPeak' | 'peak';

// State Council holiday notices (including the announced weekday days off).
// 2025: https://www.gov.cn/zhengce/zhengceku/202411/content_6986383.htm
// 2026: https://www.gov.cn/gongbao/2025/issue_12406/202511/content_7048922.html
// Never turn a make-up working weekend into a peak day.
const CHINA_HOLIDAY_RANGES: readonly (readonly [string, string])[] = [
  ['2025-01-01', '2025-01-01'], ['2025-01-28', '2025-02-04'],
  ['2025-04-04', '2025-04-06'], ['2025-05-01', '2025-05-05'],
  ['2025-05-31', '2025-06-02'], ['2025-10-01', '2025-10-08'],
  ['2026-01-01', '2026-01-03'], ['2026-02-15', '2026-02-23'],
  ['2026-04-04', '2026-04-06'], ['2026-05-01', '2026-05-05'],
  ['2026-06-19', '2026-06-21'], ['2026-09-25', '2026-09-27'],
  ['2026-10-01', '2026-10-07']
];

/** DeepSeek pricing windows use Beijing wall time, independent of host TZ. */
export function getPricingPeriod(date: Date = new Date()): PricingPeriod {
  if (!Number.isFinite(date.getTime())) throw new RangeError('Invalid pricing timestamp');
  const beijingTime = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const day = beijingTime.toISOString().slice(0, 10);
  if (CHINA_HOLIDAY_RANGES.some(([start, end]) => day >= start && day <= end)) return 'offPeak';
  const beijingDay = beijingTime.getUTCDay();
  const beijingHour = beijingTime.getUTCHours();
  const isWeekday = beijingDay >= 1 && beijingDay <= 5;
  const isPeak = isWeekday && (
    (beijingHour >= 9 && beijingHour < 12) ||
    (beijingHour >= 14 && beijingHour < 18)
  );
  return isPeak ? 'peak' : 'offPeak';
}
