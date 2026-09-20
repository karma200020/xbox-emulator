export function isXboxPlayUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname === "www.xbox.com" &&
      url.port === "" &&
      /^\/(?:[a-z]{2}-[a-z]{2}\/)?play(?:\/|$)/i.test(url.pathname);
  } catch {
    return false;
  }
}
