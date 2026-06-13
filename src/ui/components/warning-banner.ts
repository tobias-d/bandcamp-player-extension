import { dom, setText } from '@/utils/dom';

export interface WarningBannerComponent {
  update(message: string): void;
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
    root.classList.remove('is-visible');
    root.setAttribute('aria-hidden', 'true');
    setText(root, '');
    visible = false;
    lastMessage = '';
  };

  return {
    update(message) {
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
      root.classList.add('is-visible');
      root.setAttribute('aria-hidden', 'false');
      visible = true;
    },
    destroy() {
      root.remove();
    }
  };
}
