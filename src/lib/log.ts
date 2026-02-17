export function ts(): string {
  return new Date().toISOString();
}

export function log(channel: string | null, ...args: unknown[]): void {
  console.log(`${ts()} [${channel || "system"}]`, ...args);
}

export function logErr(channel: string | null, ...args: unknown[]): void {
  console.error(`${ts()} [${channel || "system"}]`, ...args);
}

export function toSqliteDatetime(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}
