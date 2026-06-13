const globalLike = globalThis as {
  chrome?: typeof chrome;
  browser?: typeof chrome;
};

export const browserApi: typeof chrome =
  globalLike.chrome ?? globalLike.browser ?? ({} as typeof chrome);
