export const LIKE_HEART_CSS = `
/* ─── Shared like-heart states (transport + playlist) ─────────────── */
.bc-btn-album-like.bc-btn-album-like-wishlist,
.bc-pl-like.liked {
  color: var(--panel-like-wishlist);
}

.bc-btn-album-like.bc-btn-album-like-collection,
.bc-pl-like.bought {
  color: var(--panel-like-collection);
}

.bc-btn-album-like-unknown .bc-heart-symbol,
.bc-pl-like.unknown .bc-heart-symbol {
  color: #363636;
  opacity: 1;
}

.bc-btn-album-like-idle .bc-heart-symbol,
.bc-pl-like.idle .bc-heart-symbol {
  color: #363636;
  opacity: 1;
}

.bc-btn-album-like:not(.bc-btn-album-like-active):not(.bc-btn-album-like-disabled):not(.bc-btn-album-like-loading):not(.bc-btn-album-like-error):hover .bc-heart-symbol {
  color: var(--panel-like-wishlist);
}

.bc-btn-album-like.bc-btn-album-like-collection:hover .bc-heart-symbol {
  color: var(--panel-like-collection);
}

.bc-btn-album-like.bc-btn-album-like-collection:hover {
  color: var(--panel-like-collection);
}

.bc-btn-album-like.bc-btn-album-like-wishlist:not(.bc-btn-album-like-disabled):not(.bc-btn-album-like-loading):not(.bc-btn-album-like-error):hover .bc-heart-symbol {
  color: var(--panel-like-empty);
}

.bc-pl-like.empty:not(.disabled):not(.loading):not(.error):hover .bc-heart-symbol,
.bc-pl-like.unknown:not(.disabled):not(.loading):not(.error):hover .bc-heart-symbol,
.bc-pl-like.idle:not(.disabled):not(.loading):not(.error):hover .bc-heart-symbol {
  color: var(--panel-like-wishlist);
}

.bc-pl-like.liked:not(.disabled):not(.loading):not(.error):hover .bc-heart-symbol {
  color: var(--panel-like-empty);
}

.bc-heart-symbol.bc-heart-loading {
  color: #363636;
  opacity: 1;
  animation: bc-like-heart-grey-pulse 1.45s ease-in-out infinite;
  will-change: opacity;
}

.bc-btn-album-like-error .bc-heart-symbol,
.bc-pl-like.error .bc-heart-symbol {
  color: #8d959e;
  opacity: 1;
  font-weight: 700;
}

@keyframes bc-like-heart-grey-pulse {
  0%, 100% {
    color: #363636;
    opacity: 1;
  }
  50% {
    color: #363636;
    opacity: 0;
  }
}
`;
