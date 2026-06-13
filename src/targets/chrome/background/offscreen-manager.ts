import type {
  ChromeAnalysisHostRequest,
  ChromeAnalysisHostResponse
} from '@/shared/chrome-analysis-host-types';
import { browserApi } from '@/utils/browser-api';
import { createLogger } from '@/utils/debug';

const logger = createLogger('BACKGROUND');

const OFFSCREEN_DOCUMENT_PATH = 'offscreen/analysis-host.html';
const OFFSCREEN_JUSTIFICATION = 'Bandcamp Deck uses an offscreen document for Chrome MV3 audio decode and analysis.';

const OFFSCREEN_IPC_TIMEOUT_MS = 30_000;

let ensureDocumentPromise: Promise<void> | null = null;
let requestCounter = 0;

type RuntimeWithContexts = typeof chrome.runtime & {
  getContexts?: (filter?: object) => Promise<Array<{ contextType?: string; documentUrl?: string }>>;
};

function isOffscreenReady(): boolean {
  return Boolean(browserApi.offscreen && browserApi.runtime?.sendMessage);
}

async function hasOffscreenDocument(): Promise<boolean> {
  const runtime = browserApi.runtime as RuntimeWithContexts | undefined;
  const getURL = browserApi.runtime?.getURL;
  if (!runtime?.getContexts || !getURL) {
    return false;
  }

  try {
    const documentUrl = getURL(OFFSCREEN_DOCUMENT_PATH);
    const contexts = await runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [documentUrl]
    });
    return Array.isArray(contexts) && contexts.length > 0;
  } catch (error) {
    logger.debug('runtime.getContexts unavailable for offscreen detection', error);
    return false;
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /single offscreen|already exists|Only a single offscreen/i.test(message);
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRetryableHostMessagingError(error: unknown): boolean {
  const message = formatErrorMessage(error);
  return /Receiving end does not exist|message channel closed before a response was received|The message port closed before a response was received/i.test(message);
}

async function wait(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

async function createOffscreenDocument(): Promise<void> {
  if (!isOffscreenReady()) {
    throw new Error('chrome-offscreen-api-unavailable');
  }

  if (await hasOffscreenDocument()) {
    return;
  }

  try {
    await browserApi.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ['AUDIO_PLAYBACK'] as chrome.offscreen.Reason[],
      justification: OFFSCREEN_JUSTIFICATION
    });
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      return;
    }
    throw error;
  }
}

export async function ensureChromeAnalysisHost(): Promise<void> {
  if (ensureDocumentPromise) {
    return ensureDocumentPromise;
  }

  ensureDocumentPromise = createOffscreenDocument()
    .finally(() => {
      ensureDocumentPromise = null;
    });

  return ensureDocumentPromise;
}

async function sendRuntimeMessage<T>(message: ChromeAnalysisHostRequest): Promise<ChromeAnalysisHostResponse<T>> {
  if (!browserApi.runtime?.sendMessage) {
    throw new Error('runtime-sendMessage-unavailable');
  }

  const send = new Promise<ChromeAnalysisHostResponse<T>>((resolve, reject) => {
    browserApi.runtime.sendMessage(message, (response: ChromeAnalysisHostResponse<T>) => {
      const lastError = browserApi.runtime?.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      resolve(response);
    });
  });

  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = globalThis.setTimeout(
      () => reject(new Error(`offscreen-ipc-timeout-${OFFSCREEN_IPC_TIMEOUT_MS}ms`)),
      OFFSCREEN_IPC_TIMEOUT_MS
    );
  });

  try {
    return await Promise.race([send, timeout]);
  } finally {
    globalThis.clearTimeout(timer);
  }
}

export async function requestChromeAnalysisHost<T>(
  action: ChromeAnalysisHostRequest['action'],
  payload?: ChromeAnalysisHostRequest['payload']
): Promise<ChromeAnalysisHostResponse<T>> {
  await ensureChromeAnalysisHost();

  const sendRequest = async (): Promise<ChromeAnalysisHostResponse<T>> => {
    const requestId = `chrome-analysis-${Date.now()}-${++requestCounter}`;
    return await sendRuntimeMessage<T>({
      target: 'chrome-analysis-host',
      requestId,
      action,
      payload: payload as ChromeAnalysisHostRequest['payload']
    } as ChromeAnalysisHostRequest);
  };

  try {
    return await sendRequest();
  } catch (error) {
    if (!isRetryableHostMessagingError(error)) {
      throw error;
    }

    logger.warn('chrome analysis host request dropped; retrying once', {
      action,
      error: formatErrorMessage(error)
    });
    await wait(120);
    await ensureChromeAnalysisHost();
    return await sendRequest();
  }
}

// Non-creating existence check. Diagnostics use this to avoid spinning up the offscreen
// document (and its AudioContext) just because the debug panel opened — if it isn't already
// running for analysis, the offscreen context simply reports "not running".
export async function hasChromeAnalysisHostDocument(): Promise<boolean> {
  return hasOffscreenDocument();
}

export async function warmChromeAnalysisHost(): Promise<void> {
  const response = await requestChromeAnalysisHost('PING');
  if (!response.ok) {
    throw new Error(response.error || 'chrome-analysis-host-ping-failed');
  }
}
