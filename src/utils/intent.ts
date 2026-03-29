const STATUS_PROBE_TEXTS = new Set([
  "status",
  "current status",
  "what's the status",
  "what is the status",
  "what's the current status",
  "what is the current status",
  "progress",
  "what's the progress",
  "what is the progress",
  "当前状态",
  "什么状态",
  "现在什么状态",
  "目前什么状态",
  "进度如何",
  "到哪了",
  "现在到哪了",
]);

function normalizeProbeText(text: string): string {
  return text
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .replace(/[?!,.!:;，。！？：；\s]+$/gu, "")
    .toLowerCase();
}

export function isStatusProbeText(text: string): boolean {
  const normalized = normalizeProbeText(text);
  if (!normalized || normalized.length > 40) {
    return false;
  }
  return STATUS_PROBE_TEXTS.has(normalized);
}
