export type ProcessParentWatchdogOptions = {
  intervalMs?: number;
  parentPid?: () => number;
  onOrphan?: () => void;
};

export function startProcessParentWatchdog(
  expectedParentPidRaw: string | undefined,
  options: ProcessParentWatchdogOptions = {},
): ReturnType<typeof setInterval> | null {
  const expectedParentPid = Number.parseInt(expectedParentPidRaw?.trim() ?? "", 10);
  if (!Number.isFinite(expectedParentPid) || expectedParentPid <= 0) return null;
  const parentPid = options.parentPid ?? (() => process.ppid);
  const onOrphan = options.onOrphan ?? (() => process.kill(process.pid, "SIGTERM"));
  const timer = setInterval(() => {
    if (parentPid() !== expectedParentPid) onOrphan();
  }, options.intervalMs ?? 500);
  timer.unref?.();
  return timer;
}
