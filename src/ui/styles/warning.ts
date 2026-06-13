export const WARNING_CSS = `
/* ─── Inline Warning Banner ─────────────────────────────────────────── */
.bc-transport-bottom-content {
  position: relative;
}

.bc-inline-warning {
  position: absolute;
  inset: 0;
  z-index: 3;
  display: none;
  align-items: center;
  justify-content: center;
  padding: 0 10px;
  border: 1px solid color-mix(in srgb, var(--panel-like-wishlist) 58%, #8a6511 42%);
  border-radius: 10px;
  background: var(--panel-like-wishlist);
  color: #1f2228;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.28px;
  text-transform: uppercase;
  line-height: 1.15;
  text-align: center;
  pointer-events: none;
  white-space: pre-line;
  overflow: hidden;
  text-overflow: clip;
  box-sizing: border-box;
}

.bc-inline-warning.is-visible {
  display: flex;
  animation: bc-inline-warning-pop 3600ms ease forwards;
}

@keyframes bc-inline-warning-pop {
  0% {
    opacity: 0;
    transform: translateY(2px);
  }
  7% {
    opacity: 1;
    transform: translateY(0);
  }
  83.3% {
    opacity: 1;
    transform: translateY(0);
  }
  100% {
    opacity: 0;
    transform: translateY(-2px);
  }
}
`;
