import { dom, setText } from '@/utils/dom';

export interface WarningBannerComponent {
  /**
   * Show `message`, or hide when empty. A transient notice (default) plays the
   * pop animation and fades out; a `sticky` notice holds on screen until replaced
   * or cleared — used for the extension-reloaded "refresh this tab" notice.
   */
  update(message: string, sticky?: boolean): void;
  destroy(): void;
}

export function createWarningBanner(container: HTMLElement): WarningBannerComponent {
  const root = dom('div', {
    class: 'bc-inline-warning',
    role: 'status',
    'aria-live': 'polite',
    'aria-hidden': 'true'
  }, ['']);

  container.appendChild(root);

  let visible = false;
  let lastMessage = '';

  const hide = (): void => {
    root.classList.remove('is-visible', 'is-sticky');
    root.setAttribute('aria-hidden', 'true');
    setText(root, '');
    visible = false;
    lastMessage = '';
  };

  return {
    update(message, sticky = false) {
      const nextMessage = String(message || '').trim();
      if (!nextMessage) {
        hide();
        return;
      }
      if (visible && nextMessage === lastMessage) {
        return;
      }
      lastMessage = nextMessage;
      setText(root, nextMessage);
      root.classList.remove('is-visible');
      // Force reflow so repeated warnings restart the animation.
      void root.offsetHeight;
      root.classList.toggle('is-sticky', sticky);
      root.classList.add('is-visible');
      root.setAttribute('aria-hidden', 'false');
      visible = true;
    },
    destroy() {
      root.remove();
    }
  };
}
