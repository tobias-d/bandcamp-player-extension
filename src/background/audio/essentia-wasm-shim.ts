import { extensionAssetUrl } from '@/utils/asset-url';

type ShimScope = typeof globalThis & Record<string, unknown>;

let loadPromise: Promise<unknown> | null = null;

function currentModule(scope: ShimScope): unknown {
  const moduleRecord = Reflect.get(scope, 'module') as { exports?: Record<string, unknown> } | undefined;
  const exportsRecord = Reflect.get(scope, 'exports') as Record<string, unknown> | undefined;

  return Reflect.get(scope, '__BC_ESSENTIA_WASM_MODULE__')
    ?? moduleRecord?.exports?.EssentiaWASM
    ?? exportsRecord?.EssentiaWASM
    ?? Reflect.get(scope, 'EssentiaWASM')
    ?? null;
}

function loadWithScriptTag(scope: ShimScope, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = scope.document;
    if (!doc) {
      reject(new Error('Essentia document loader unavailable'));
      return;
    }

    const script = doc.createElement('script');
    script.src = url;
    script.async = true;
    script.onload = () => {
      script.remove();
      resolve();
    };
    script.onerror = () => {
      script.remove();
      reject(new Error(`Failed to load ${url}`));
    };
    (doc.head ?? doc.documentElement).appendChild(script);
  });
}

export async function EssentiaWASM(): Promise<unknown> {
  const scope = globalThis as ShimScope;
  const existing = currentModule(scope);

  if (existing) {
    scope.__BC_ESSENTIA_WASM_MODULE__ = existing;
    return existing;
  }

  if (!loadPromise) {
    loadPromise = (async () => {
      const url = extensionAssetUrl('essentia-wasm.umd.js');
      const previousExports = Reflect.get(scope, 'exports') as Record<string, unknown> | undefined;
      const previousModule = Reflect.get(scope, 'module') as { exports?: Record<string, unknown> } | undefined;
      const shimExports: Record<string, unknown> = {};

      Reflect.set(scope, 'exports', shimExports);
      Reflect.set(scope, 'module', { exports: shimExports });

      try {
        if (typeof scope.importScripts === 'function') {
          scope.importScripts(url);
        } else {
          await loadWithScriptTag(scope, url);
        }

        const loaded = currentModule(scope);
        if (!loaded) {
          throw new Error('Essentia asset loaded without EssentiaWASM export');
        }

        Reflect.set(scope, '__BC_ESSENTIA_WASM_MODULE__', loaded);
        return loaded;
      } finally {
        Reflect.set(scope, 'exports', previousExports);
        Reflect.set(scope, 'module', previousModule);
      }
    })().catch((error) => {
      loadPromise = null;
      throw error;
    });
  }

  return loadPromise;
}

export default { EssentiaWASM };
