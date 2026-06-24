/** 매일 반복 메일 — 타임존·로컬 시각 판정 (cron 5분 주기) */

export function parseTimeLocal(raw) {
  const s = String(raw ?? "").trim();
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?/.exec(s);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

export function sanitizeTimeLocal(raw, fallback = "09:00") {
  const parsed = parseTimeLocal(raw);
  if (!parsed) return fallback;
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(parsed.hour)}:${pad(parsed.minute)}`;
}

function localParts(date, timezone) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
  let hour = Number(get("hour"));
  if (!Number.isFinite(hour) || hour === 24) hour = 0;
  const minute = Number(get("minute"));
  return {
    localDate: `${get("year")}-${get("month")}-${get("day")}`,
    hour,
    minute: Number.isFinite(minute) ? minute : 0,
  };
}

/** 오늘(타임존) 아직 발송 안 했고, 로컬 시각이 timeLocal 이후 (cron 5분·지연 대비) */
export function isRecurringEmailDue(schedule, now = new Date()) {
  if (!schedule?.enabled) return false;
  const tz = String(schedule.timezone ?? "Asia/Seoul");
  const timeLocal = sanitizeTimeLocal(schedule.timeLocal);
  const parsed = parseTimeLocal(timeLocal);
  if (!parsed) return false;

  const { localDate, hour, minute } = localParts(now, tz);
  if (schedule.lastSentLocalDate === localDate) return false;

  const nowMins = hour * 60 + minute;
  const schedMins = parsed.hour * 60 + parsed.minute;
  if (nowMins < schedMins) return false;
  return true;
}

export function localDateInTimezone(now = new Date(), timezone = "Asia/Seoul") {
  return localParts(now, timezone).localDate;
}

export function formatRecurringLabel(timeLocal, timezone) {
  const tz = String(timezone ?? "Asia/Seoul");
  const t = sanitizeTimeLocal(timeLocal);
  const labels = {
    "Asia/Seoul": "한국",
    "Asia/Tokyo": "일본",
    UTC: "UTC",
  };
  return `매일 ${t} (${labels[tz] ?? tz})`;
}
