export function getLikelyCurrentSrc(): string {
  const audios = Array.from(document.querySelectorAll('audio')) as HTMLAudioElement[];
  const playing = audios.find((audio) => !audio.paused && !audio.ended && Boolean(audio.currentSrc || audio.src));
  if (playing) {
    return playing.currentSrc || playing.src || '';
  }
  const withSrc = audios.find((audio) => Boolean(audio.currentSrc || audio.src));
  return withSrc?.currentSrc || withSrc?.src || '';
}
