export function randomHighPort(): number {
  return 20000 + Math.floor(Math.random() * 40000);
}

export function parseSetCookies(response: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of response.headers.getSetCookie()) {
    const pair = entry.split(';', 1)[0] ?? '';
    const eq = pair.indexOf('=');
    if (eq > 0) {
      out[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
  }
  return out;
}

export function cookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}
