import { dispatchSharedRuntimeMessage, registerRuntimeRouter } from '@/background/router-core';

export function registerRouter(): void {
  registerRuntimeRouter(dispatchSharedRuntimeMessage);
}
