interface DeferredRefreshControllerOptions {
  rootLikePage: boolean;
  rootRetryDelaysMs: readonly number[];
  getCurrentSourceVersion(): number;
  hasMultiplePlaylistTracks(): boolean;
  isPlaylistUnresolved(): boolean;
  onPlaylistRefresh(allowApiFetch: boolean): void;
  onPlaylistAfterRefresh(expectedSourceVersion: number): void;
  onMetadataRefresh(expectedSourceVersion: number, allowApiFetch: boolean): void;
}

interface SchedulePlaylistRefreshOptions {
  delayMs?: number;
  expectedSourceVersion?: number;
  allowApiFetch?: boolean;
}

interface ScheduleMetadataRefreshOptions {
  delayMs?: number;
  expectedSourceVersion?: number;
  allowApiFetch?: boolean;
}

const NON_ROOT_RETRY_DELAYS_MS = [700, 1600] as const;

export interface DeferredRefreshController {
  cancelPlaylistRefresh(): void;
  cancelMetadataRefresh(): void;
  cancelAll(): void;
  schedulePlaylistRefresh(options?: SchedulePlaylistRefreshOptions): void;
  schedulePlaylistRetries(expectedSourceVersion?: number): void;
  scheduleMetadataRefresh(options?: ScheduleMetadataRefreshOptions): void;
}

export function createDeferredRefreshController(
  options: DeferredRefreshControllerOptions
): DeferredRefreshController {
  let deferredPlaylistRefreshId: number | null = null;
  let deferredPlaylistRetryIds: number[] = [];
  let deferredMetadataRefreshId: number | null = null;

  const cancelPlaylistRefresh = (): void => {
    if (deferredPlaylistRefreshId !== null) {
      window.clearTimeout(deferredPlaylistRefreshId);
      deferredPlaylistRefreshId = null;
    }
    deferredPlaylistRetryIds.forEach((timerId) => window.clearTimeout(timerId));
    deferredPlaylistRetryIds = [];
  };

  const cancelMetadataRefresh = (): void => {
    if (deferredMetadataRefreshId === null) {
      return;
    }
    window.clearTimeout(deferredMetadataRefreshId);
    deferredMetadataRefreshId = null;
  };

  const schedulePlaylistRefresh = (scheduleOptions: SchedulePlaylistRefreshOptions = {}): void => {
    const expectedSourceVersion = Number.isInteger(scheduleOptions.expectedSourceVersion)
      ? Number(scheduleOptions.expectedSourceVersion)
      : options.getCurrentSourceVersion();
    const delayMs = Math.max(0, Number(scheduleOptions.delayMs ?? 140));
    const allowApiFetch = Boolean(scheduleOptions.allowApiFetch ?? true);

    if (deferredPlaylistRefreshId !== null) {
      window.clearTimeout(deferredPlaylistRefreshId);
      deferredPlaylistRefreshId = null;
    }

    deferredPlaylistRefreshId = window.setTimeout(() => {
      deferredPlaylistRefreshId = null;
      if (expectedSourceVersion !== options.getCurrentSourceVersion()) {
        return;
      }
      options.onPlaylistRefresh(allowApiFetch);
      options.onPlaylistAfterRefresh(expectedSourceVersion);
    }, delayMs);
  };

  const schedulePlaylistRetries = (expectedSourceVersion = options.getCurrentSourceVersion()): void => {
    deferredPlaylistRetryIds.forEach((timerId) => window.clearTimeout(timerId));
    deferredPlaylistRetryIds = [];

    const delays = options.rootLikePage ? options.rootRetryDelaysMs : NON_ROOT_RETRY_DELAYS_MS;
    delays.forEach((delayMs, index) => {
      const timerId = window.setTimeout(() => {
        if (expectedSourceVersion !== options.getCurrentSourceVersion()) {
          return;
        }
        if (options.hasMultiplePlaylistTracks()) {
          return;
        }

        const unresolved = options.isPlaylistUnresolved();
        const allowApiFetch = options.rootLikePage ? (unresolved || index > 0) : true;
        options.onPlaylistRefresh(allowApiFetch);
        options.onPlaylistAfterRefresh(expectedSourceVersion);
      }, delayMs);
      deferredPlaylistRetryIds.push(timerId);
    });
  };

  const scheduleMetadataRefresh = (scheduleOptions: ScheduleMetadataRefreshOptions = {}): void => {
    const expectedSourceVersion = Number.isInteger(scheduleOptions.expectedSourceVersion)
      ? Number(scheduleOptions.expectedSourceVersion)
      : options.getCurrentSourceVersion();
    const delayMs = Math.max(0, Number(scheduleOptions.delayMs ?? 220));
    const allowApiFetch = Boolean(scheduleOptions.allowApiFetch);

    cancelMetadataRefresh();
    deferredMetadataRefreshId = window.setTimeout(() => {
      deferredMetadataRefreshId = null;
      if (expectedSourceVersion !== options.getCurrentSourceVersion()) {
        return;
      }
      options.onMetadataRefresh(expectedSourceVersion, allowApiFetch);
    }, delayMs);
  };

  return {
    cancelPlaylistRefresh,
    cancelMetadataRefresh,
    cancelAll() {
      cancelPlaylistRefresh();
      cancelMetadataRefresh();
    },
    schedulePlaylistRefresh,
    schedulePlaylistRetries,
    scheduleMetadataRefresh
  };
}
