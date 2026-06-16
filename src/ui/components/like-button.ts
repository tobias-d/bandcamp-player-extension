import type { PanelInput } from '@/shared/types';
import { dom, setText } from '@/utils/dom';

export interface LikeButtonComponent {
  update(input: PanelInput): void;
  destroy(): void;
}

export function createLikeButton(
  container: HTMLElement,
  handlers: {
    onToggleAlbumLike(): void;
  }
): LikeButtonComponent {
  let hardDisabled = false;
  const heart = dom('span', { class: 'bc-heart-symbol', 'aria-hidden': 'true' }, ['♥']);
  const btn = dom(
    'button',
    {
      type: 'button',
      class: 'bc-btn bc-btn-album-like bc-header-album-like',
      title: 'Album Like'
    },
    [heart]
  );
  container.appendChild(btn);
  btn.addEventListener('click', () => {
    if (hardDisabled) {
      return;
    }
    handlers.onToggleAlbumLike();
  });

  return {
    update(input) {
      const albumState = input.likeState.albumState;
      const albumLiked = albumState === 'liked' || albumState === 'bought';
      const inWishlist = albumState === 'liked';
      const inCollection = albumState === 'bought';
      const unknownState = albumState === 'unknown';
      const likeLoading = Boolean(input.likeState.loading);
      const syncDisabled = Boolean(input.likeState.disabled) && !inCollection;
      const likeDisabled = syncDisabled || inCollection;
      const likeError = String(input.likeState.notice || '').trim() === 'sync-error';
      const loadingState = unknownState && likeLoading && !likeError;
      const idleState = !loadingState && !likeError && input.playlist.tracks.length === 0;
      const showErrorSymbol = likeError;
      hardDisabled = inCollection;

      setText(heart, showErrorSymbol ? '!' : '♥');
      btn.classList.toggle('bc-btn-album-like-active', albumLiked);
      btn.classList.toggle('bc-btn-album-like-wishlist', inWishlist);
      btn.classList.toggle('bc-btn-album-like-collection', inCollection);
      btn.classList.toggle('bc-btn-album-like-loading', loadingState);
      btn.classList.toggle('bc-btn-album-like-error', likeError);
      btn.classList.toggle('bc-btn-album-like-idle', unknownState && idleState);
      heart.classList.toggle('bc-heart-loading', loadingState);
      btn.classList.toggle(
        'bc-btn-album-like-unknown',
        unknownState && !loadingState && !likeError && !idleState
      );
      btn.classList.toggle('bc-btn-album-like-disabled', likeDisabled);
      btn.disabled = hardDisabled;
      btn.setAttribute('aria-disabled', likeDisabled ? 'true' : 'false');
      btn.title = inCollection
        ? 'You own this'
        : loadingState
          ? 'Refreshing like status...'
          : likeError
            ? 'Status unavailable (!)'
            : inWishlist
              ? 'Remove from your wishlist'
              : 'Add to your wishlist';
      btn.setAttribute('aria-label', btn.title);
    },
    destroy() {
      btn.remove();
    }
  };
}
