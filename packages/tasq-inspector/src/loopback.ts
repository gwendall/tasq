const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function normalizeHost(value: string): string {
  const hostname = value.trim().toLocaleLowerCase("en-US");
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

export function assertLoopbackHost(value: string): string {
  const hostname = normalizeHost(value);
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new Error("Tasq inspector only accepts a loopback host before authenticated hosting exists");
  }
  return hostname;
}

export function isLoopbackHost(value: string): boolean {
  return LOOPBACK_HOSTS.has(normalizeHost(value));
}
