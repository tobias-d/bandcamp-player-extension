import { initBackgroundRuntime } from '@/background/init';
import { registerRouter } from '@/targets/firefox/background/router';

initBackgroundRuntime(registerRouter);
