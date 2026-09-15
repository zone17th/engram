/** Keep locale rewrites internal when NextURL maps 127.0.0.1 to localhost. */
export function withRequestOrigin(target: string, requestUrl: string, normalizedOrigin: string): string {
  const destination = new URL(target);
  if (destination.origin !== normalizedOrigin) return target;

  const incoming = new URL(requestUrl);
  destination.protocol = incoming.protocol;
  destination.host = incoming.host;
  return destination.toString();
}
