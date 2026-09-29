export type DashboardRange = "today" | "yesterday" | "7d" | "30d" | "custom";
function dhakaDay(offsetDays = 0, now = Date.now()) {
  const shifted = new Date(now + 6 * 3_600_000);
  shifted.setUTCDate(shifted.getUTCDate() + offsetDays);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - 6 * 3_600_000);
}
export function dashboardDateRange(
  range: DashboardRange,
  fromValue?: string,
  toValue?: string,
  now = Date.now(),
) {
  const current = new Date(now);
  if (range === "today") return { from: dhakaDay(0, now), to: current };
  if (range === "yesterday")
    return { from: dhakaDay(-1, now), to: dhakaDay(0, now) };
  if (range === "7d") return { from: dhakaDay(-6, now), to: current };
  if (range === "30d") return { from: dhakaDay(-29, now), to: current };
  const from = fromValue ? new Date(fromValue) : null;
  const to = toValue ? new Date(toValue) : null;
  if (
    !from ||
    !to ||
    Number.isNaN(from.getTime()) ||
    Number.isNaN(to.getTime()) ||
    from >= to ||
    to.getTime() - from.getTime() > 366 * 86_400_000
  )
    return null;
  return { from, to };
}
