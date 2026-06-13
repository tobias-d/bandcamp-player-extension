export function jumpViaPrevNext(params: {
  targetIndex: number;
  currentIndex: number;
  totalTracks: number;
  clickGlobalPrevNext(direction: number): { ok: boolean; selector: string };
}): { ok: boolean; detail: string } {
  const { targetIndex, currentIndex, totalTracks, clickGlobalPrevNext } = params;
  if (totalTracks <= 1 || currentIndex < 0 || targetIndex < 0 || currentIndex === targetIndex) {
    return { ok: false, detail: 'none' };
  }
  const forwardSteps = (targetIndex - currentIndex + totalTracks) % totalTracks;
  const backwardSteps = (currentIndex - targetIndex + totalTracks) % totalTracks;
  const direction = forwardSteps <= backwardSteps ? 1 : -1;
  const steps = Math.min(forwardSteps, backwardSteps);
  if (steps <= 0) {
    return { ok: false, detail: 'none' };
  }
  const collectionContext = Boolean(
    document.querySelector('.collection-item-container, .track_play_hilite, #collection-player, .collection-player')
  );
  if (!collectionContext && steps !== 1) {
    return { ok: false, detail: 'steps>1-non-collection' };
  }
  let lastSelector = '-';
  for (let i = 0; i < steps; i += 1) {
    const result = clickGlobalPrevNext(direction);
    if (!result.ok) {
      return { ok: false, detail: `step=${i + 1}` };
    }
    lastSelector = result.selector;
  }
  return {
    ok: true,
    detail: `to=${targetIndex} steps=${steps} via=${lastSelector}`
  };
}
