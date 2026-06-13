export const WAVEFORM_CSS = `
/* ─── Waveform ──────────────────────────────────────────────────────── */
.bc-waveform-stub {
  height: 78px;
  width: calc(100% - (var(--transport-side-inset) * 2));
  margin-top: 0;
  margin-bottom: var(--panel-stack-gap);
  margin-left: auto;
  margin-right: auto;
  box-sizing: border-box;
  border: 0;
  border-radius: 12px;
  background: transparent;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  box-shadow: none;
  color: var(--panel-text-dim);
  font-size: 11px;
  display: block;
  letter-spacing: 0.24px;
  cursor: pointer;
  position: relative;
  overflow: hidden;
}

.bc-waveform-canvas {
  width: 100%;
  height: 100%;
  display: block;
  outline: none;
}

.bc-waveform-seek-overlay {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: var(--wave-seek-overlay-width, 0px);
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  z-index: 2;
  background: rgba(92, 92, 96, 0.25);
  mix-blend-mode: saturation;
  transition: opacity 140ms ease, visibility 0s linear 140ms;
}

.bc-waveform-seek-overlay.isVisible {
  opacity: 1;
  visibility: visible;
  transition: opacity 100ms ease, visibility 0s linear 0s;
  animation: bcWaveSeekOverlay 900ms ease-in-out infinite;
}

.bc-waveform-loading {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 2px;
  height: 78px;
  opacity: 0;
  visibility: hidden;
  overflow: hidden;
  pointer-events: none;
  user-select: none;
  z-index: 3;
  contain: layout paint;
  transition: opacity 1200ms cubic-bezier(0.2, 0.64, 0.24, 1), visibility 0s linear 1200ms;
}

.bc-waveform-loading.isVisible {
  opacity: 1;
  visibility: visible;
  transition: opacity 220ms cubic-bezier(0.22, 0.61, 0.36, 1), visibility 0s linear 0s;
}

.bc-waveform-loading.isWaveReady {
  opacity: 0;
  visibility: visible;
  transition: opacity 720ms cubic-bezier(0.22, 0.61, 0.36, 1), visibility 0s linear 0s;
}

.bc-waveform-loading-dot {
  position: absolute;
  top: 50%;
  left: 0;
  width: calc(var(--dot-tail, 22px) + var(--dot-size, 3px));
  height: var(--dot-size, 3px);
  border-radius: 999px;
  background: linear-gradient(
    90deg,
    rgba(var(--dot-rgb, 113,106,169), 0) 0%,
    rgba(var(--dot-rgb, 113,106,169), 0.12) 42%,
    rgba(var(--dot-rgb, 113,106,169), var(--dot-alpha, 0.62)) 80%,
    rgba(var(--dot-rgb, 113,106,169), 0.98) 100%
  );
  box-shadow: 0 0 10px rgba(var(--dot-rgb, 113,106,169), 0.28);
  opacity: 0;
  transform: translate3d(calc(-1 * (var(--dot-tail, 22px) + var(--dot-size, 3px) + 12px)), calc(-50% + var(--dot-y, 0px)), 0) scale(0.82);
  animation: bcWaveDotStream calc(var(--dot-duration, 0.8s) * var(--wave-dot-speed-multiplier, 1)) linear infinite;
  animation-delay: var(--dot-delay, 0s);
  will-change: transform, opacity;
}

.bc-waveform-loading:not(.isVisible) .bc-waveform-loading-dot,
.bc-waveform-loading-dot.isInactive {
  animation-play-state: paused;
}

.bc-waveform-loading-dot.isInactive {
  opacity: 0 !important;
  visibility: hidden;
}

.bc-waveform-loading-dot::after {
  content: '';
  position: absolute;
  top: 50%;
  right: -1px;
  width: var(--dot-size, 3px);
  height: var(--dot-size, 3px);
  transform: translateY(-50%);
  border-radius: 50%;
  background: rgba(var(--dot-rgb, 113,106,169), 1);
  box-shadow: 0 0 9px rgba(var(--dot-rgb, 113,106,169), 0.56);
}

.bc-waveform-status {
  position: absolute;
  left: 10px;
  bottom: 8px;
  font-size: 11px;
  line-height: 1.25;
  letter-spacing: 0.2px;
  color: rgba(20, 23, 29, 0.72);
  text-shadow: 0 1px 0 rgba(255, 255, 255, 0.35);
  pointer-events: none;
}

.bc-waveform-ready .bc-waveform-status {
  color: rgba(20, 23, 29, 0.5);
}

@keyframes bcWaveDotStream {
  0% {
    opacity: 0;
    transform: translate3d(calc(-1 * (var(--dot-tail, 22px) + var(--dot-size, 3px) + 12px)), calc(-50% + var(--dot-y, 0px)), 0) scale(0.78);
  }

  7% {
    opacity: 0.46;
  }

  28% {
    opacity: 0.88;
  }

  72% {
    opacity: 0.78;
  }

  100% {
    opacity: 0;
    transform: translate3d(calc(var(--wave-loading-width, 320px) + 12px), calc(-50% + var(--dot-y, 0px) + var(--dot-drift, 0px)), 0) scale(1);
  }
}

@keyframes bcWaveSeekOverlay {
  0%, 100% {
    opacity: 0.62;
    filter: saturate(0.18) brightness(0.94);
  }

  50% {
    opacity: 1;
    filter: saturate(0.04) brightness(1.05);
  }
}
`;
