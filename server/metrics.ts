// Prometheus text exposition, written by hand: a few lines, no client library needed.
const requests = new Map<string, number>();

export function countRequest(method: string, route: string, status: number) {
  const key = `method="${method}",route="${route}",status="${status}"`;
  requests.set(key, (requests.get(key) ?? 0) + 1);
}

export interface Gauges {
  spaces: number;
  /** Bytes stored over every space, at the last sync. */
  stored: number;
  /** Whether the last sync with OpenCloud worked, or null before the first. */
  syncOk: boolean | null;
  /** Links to people outside that still work. */
  links: number;
  linksWithoutPassword: number;
  /** Handovers planned for people who leave. */
  handovers: number;
  /** 1 when the spaces file on disk could not be applied and an older version is in use. */
  fileError: boolean;
}

export function renderMetrics(version: string, g: Gauges): string {
  const lines = [
    "# HELP openasy_build_info Build information.",
    "# TYPE openasy_build_info gauge",
    `openasy_build_info{product="files",version="${version}"} 1`,
    "# HELP openasy_http_requests_total HTTP requests handled.",
    "# TYPE openasy_http_requests_total counter",
    ...[...requests].map(([labels, n]) => `openasy_http_requests_total{${labels}} ${n}`),
    "# HELP openasy_files_spaces Spaces in the spaces file.",
    "# TYPE openasy_files_spaces gauge",
    `openasy_files_spaces ${g.spaces}`,
    "# HELP openasy_files_stored_bytes Bytes stored over every space, at the last sync.",
    "# TYPE openasy_files_stored_bytes gauge",
    `openasy_files_stored_bytes ${g.stored}`,
    "# HELP openasy_files_sync_ok 1 when OpenCloud was last brought in step with the file, 0 when that failed.",
    "# TYPE openasy_files_sync_ok gauge",
    ...(g.syncOk === null ? [] : [`openasy_files_sync_ok ${g.syncOk ? 1 : 0}`]),
    "# HELP openasy_files_links Links to people outside that still work.",
    "# TYPE openasy_files_links gauge",
    `openasy_files_links ${g.links}`,
    "# HELP openasy_files_links_without_password Working links without a password.",
    "# TYPE openasy_files_links_without_password gauge",
    `openasy_files_links_without_password ${g.linksWithoutPassword}`,
    "# HELP openasy_files_handovers_planned Handovers planned for people who leave.",
    "# TYPE openasy_files_handovers_planned gauge",
    `openasy_files_handovers_planned ${g.handovers}`,
    "# HELP openasy_files_config_error 1 when the spaces file could not be applied and its last good version is in use.",
    "# TYPE openasy_files_config_error gauge",
    `openasy_files_config_error ${g.fileError ? 1 : 0}`,
    "# HELP process_uptime_seconds Seconds since the process started.",
    "# TYPE process_uptime_seconds gauge",
    `process_uptime_seconds ${process.uptime().toFixed(0)}`,
  ];
  return lines.join("\n") + "\n";
}
