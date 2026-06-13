import type { AnalyzeKeyDebugResponse, KeyAnalysisDebugResult, KeyAnalysisParams } from '@/shared/types';
import { sendMessage } from '@/utils/messaging';
import { getDefaultKeyParams, hideKeyTuningPanel, isKeyTuningVisible, showKeyTuningPanel } from '@/ui/key-tuning-panel';

export interface KeyTuningController {
  toggle(): void;
  destroy(): void;
}

interface KeyTuningControllerOptions {
  getCurrentUrl: () => string;
  getCurrentBpm: () => number | undefined;
  getCurrentMetadata: () => { artistName: string; trackTitle: string; albumTitle: string; confidence: 'high' | 'medium' | 'low' };
}

type PanelStatus = 'idle' | 'analyzing' | 'ready' | 'error';

export function createKeyTuningController(options: KeyTuningControllerOptions): KeyTuningController {
  let currentParams: KeyAnalysisParams = getDefaultKeyParams();
  let lastUrl = '';
  let lastBpm: number | undefined;
  let lastDebug: KeyAnalysisDebugResult | null = null;
  let status: PanelStatus = 'idle';
  let statusText = 'Paste a track URL and click Analyze.';

  const render = (): void => {
    const autoUrl = String(options.getCurrentUrl() || '').trim();
    const autoBpm = options.getCurrentBpm();
    const metadata = options.getCurrentMetadata();
    showKeyTuningPanel(
      {
        status,
        statusText,
        debugData: lastDebug,
        params: currentParams,
        url: autoUrl || lastUrl,
        bpm: autoBpm ?? lastBpm,
        metadata
      },
      {
        onClose: () => hideKeyTuningPanel(),
        onParamsChange: (next) => {
          const shouldRerun = Boolean(lastDebug)
            && (next.profileType !== currentParams.profileType || next.pcpSize !== currentParams.pcpSize)
            && Boolean(lastUrl);
          currentParams = { ...next };
          if (shouldRerun) {
            void analyze(lastUrl, lastBpm);
            return;
          }
          if (!lastDebug) {
            status = 'idle';
            statusText = 'Parameters updated.';
          }
          render();
        },
        onAnalyzeUrl: (url, bpm) => {
          const resolvedUrl = String(url || '').trim() || String(options.getCurrentUrl() || '').trim();
          const resolvedBpm = bpm ?? options.getCurrentBpm();
          if (!resolvedUrl) {
            status = 'error';
            statusText = 'No URL available.';
            render();
            return;
          }
          void analyze(resolvedUrl, resolvedBpm);
        },
        onUseCurrentTrack: () => {
          const url = String(options.getCurrentUrl() || '').trim();
          if (!url) {
            return null;
          }
          const bpm = options.getCurrentBpm();
          if (!Number.isFinite(bpm)) {
            return { url };
          }
          return { url, bpm };
        }
      }
    );
  };

  const analyze = async (url: string, bpm?: number): Promise<void> => {
    lastUrl = String(url || '').trim();
    lastBpm = bpm;
    status = 'analyzing';
    statusText = 'Analyzing key windows...';
    render();

    try {
      const response = await sendMessage<AnalyzeKeyDebugResponse>({
        type: 'ANALYZE_KEY_DEBUG',
        url: lastUrl,
        bpm: lastBpm,
        params: currentParams
      });

      if (!response?.debug) {
        status = 'error';
        statusText = response?.error || 'Analyze failed';
        render();
        return;
      }

      lastDebug = response.debug;
      status = 'ready';
      statusText = `Loaded ${response.debug.windows.length} windows`;
      render();
    } catch (error) {
      status = 'error';
      statusText = `Analyze failed: ${error instanceof Error ? error.message : String(error)}`;
      render();
    }
  };

  const openPanel = (): void => {
    const autoUrl = String(options.getCurrentUrl() || '').trim();
    const autoBpm = options.getCurrentBpm();
    if (autoUrl) {
      lastUrl = autoUrl;
    } else if (!lastUrl) {
      lastUrl = String(window.location.href || '').trim();
    }
    if (Number.isFinite(autoBpm)) {
      lastBpm = autoBpm;
    }
    render();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!event.altKey || event.code !== 'KeyK' || event.repeat) {
      return;
    }
    event.preventDefault();
    if (isKeyTuningVisible()) {
      hideKeyTuningPanel();
      return;
    }
    openPanel();
  };

  document.addEventListener('keydown', onKeyDown, true);

  return {
    toggle(): void {
      if (isKeyTuningVisible()) {
        hideKeyTuningPanel();
      } else {
        openPanel();
      }
    },
    destroy(): void {
      document.removeEventListener('keydown', onKeyDown, true);
      hideKeyTuningPanel();
    }
  };
}
