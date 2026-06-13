import { initEssentiaRuntime } from '@/background/audio/essentia-runtime';
import { getWorkerPool } from '@/background/audio/worker-pool';
import { registerPlaybackCommandHandlers } from '@/background/handlers/playback-handoff';
import { registerWelcomeMarker } from '@/background/welcome-marker';
import { createLogger } from '@/utils/debug';

const logger = createLogger('BACKGROUND');

export function initBackgroundRuntime(registerRouter: () => void): void {
  registerWelcomeMarker();
  registerRouter();
  registerPlaybackCommandHandlers();
  void initEssentiaRuntime()
    .then(() => {
      logger.info('Background initialized (router + essentia runtime)');
    })
    .catch((error) => {
      logger.warn('Essentia warmup failed; lazy init will retry', error);
    });
  void getWorkerPool().initialize()
    .then(() => {
      logger.info('Analysis worker pool ready');
    })
    .catch((error) => {
      logger.warn('Worker pool init failed; analysis will continue on the service worker thread', error);
    });
}
