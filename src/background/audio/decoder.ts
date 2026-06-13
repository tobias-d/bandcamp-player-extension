let sharedDecodeContext: AudioContext | null = null;

function getDecodeContext(): AudioContext {
  if (sharedDecodeContext && sharedDecodeContext.state !== 'closed') {
    return sharedDecodeContext;
  }

  const ContextCtor = (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).AudioContext
    || (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

  if (!ContextCtor) {
    throw new Error('AudioContext unavailable in background');
  }

  sharedDecodeContext = new ContextCtor();
  return sharedDecodeContext;
}

export async function decodeAudio(arrayBuffer: ArrayBuffer): Promise<AudioBuffer> {
  let context = getDecodeContext();

  try {
    return await context.decodeAudioData(arrayBuffer);
  } catch {
    // Recover from invalidated shared context.
    sharedDecodeContext = null;
    context = getDecodeContext();
    return await context.decodeAudioData(arrayBuffer);
  }
}
