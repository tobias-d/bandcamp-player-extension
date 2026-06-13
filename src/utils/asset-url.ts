export function extensionAssetUrl(path: string): string {
  const normalizedPath = path.replace(/^\/+/, '');
  const runtime =
    (globalThis as { browser?: { runtime?: { getURL?: (p: string) => string } } }).browser?.runtime ??
    (globalThis as { chrome?: { runtime?: { getURL?: (p: string) => string } } }).chrome?.runtime;

  if (runtime?.getURL) {
    return runtime.getURL(normalizedPath);
  }

  return `/${normalizedPath}`;
}
