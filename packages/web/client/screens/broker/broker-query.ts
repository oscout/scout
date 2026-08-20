export const BROKER_PAGE_LIMIT = 160;

export function brokerDiagnosticsUrl(cursor?: string | null): string {
  const params = new URLSearchParams({
    limit: String(BROKER_PAGE_LIMIT),
  });
  if (cursor) params.set("cursor", cursor);
  return `/api/broker?${params.toString()}`;
}
