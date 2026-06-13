import { BRIDGE_MARKER, ORIGIN_BRIDGE_ASSET_PATH } from '@/content/discover/origin-bridge/constants';
import { extensionAssetUrl } from '@/utils/asset-url';

const INJECTED_BRIDGE_SCRIPT_ID = 'bc-player-origin-bridge-script';

let bridgeScriptStatus: 'idle' | 'pending' | 'loaded' = 'idle';

export function injectBridgeScript(): void {
  if (bridgeScriptStatus === 'pending' || bridgeScriptStatus === 'loaded') {
    return;
  }

  if ((window as unknown as Record<string, unknown>)[BRIDGE_MARKER]) {
    bridgeScriptStatus = 'loaded';
    return;
  }

  const existingScript = document.getElementById(INJECTED_BRIDGE_SCRIPT_ID);

  if (existingScript) {
    bridgeScriptStatus = 'pending';
    return;
  }

  const script = document.createElement('script');
  const scriptUrl = extensionAssetUrl(ORIGIN_BRIDGE_ASSET_PATH);

  bridgeScriptStatus = 'pending';
  script.id = INJECTED_BRIDGE_SCRIPT_ID;
  script.src = scriptUrl;
  script.async = false;
  script.onload = () => {
    bridgeScriptStatus = 'loaded';
    script.remove();
  };
  script.onerror = () => {
    bridgeScriptStatus = 'idle';
    script.remove();
  };

  (document.documentElement || document.head || document.body).appendChild(script);
}
