import { initBackgroundRuntime } from '@/background/init';
import { warmChromeAnalysisHost } from '@/targets/chrome/background/offscreen-manager';
import { registerRouter } from '@/targets/chrome/background/router';
import { createLogger } from '@/utils/debug';

const logger = createLogger('BACKGROUND');

// Chrome MV3 runs the background as a service worker, so Firefox-only
// background-page hooks such as webRequest CSP patching must not run here.
initBackgroundRuntime(registerRouter);

void warmChromeAnalysisHost()
  .then(() => {
    logger.info('Chrome analysis offscreen host ready');
  })
  .catch((error) => {
    logger.warn('Chrome analysis offscreen host warmup failed', error);
  });
