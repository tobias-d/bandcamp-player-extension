import { dom } from '@/utils/dom';
import { createConfirmDialog, ConfirmDialog } from '@/ui/components/confirm-dialog';

// Chrome-only confirm dialog for switching the Preload tracks control to/from its High level (the
// level that turns on the higher predecode tier, formerly the standalone "Performance mode"). It is
// a thin wrapper over the shared confirm-dialog modal; only the High-specific copy, button labels,
// and the reload-on-confirm live here. `next` is the target Performance-mode flag: true when moving
// up to High, false when moving down to Normal or Off.

// Body content is built from nodes (not a flat string) so the RAM requirement can be bold.
function performanceConfirmBodyNodes(next: boolean): (string | Node)[] {
  if (!next) {
    return ['This lowers how much is prepared ahead and frees the extra memory. The page will reload to apply the change.'];
  }
  return [
    'High preloading keeps much more of your playlist decoded and ready, so skipping between tracks ' +
      'stays instant even in long lists. ',
    dom('strong', {}, ['Only choose High if your computer has at least 16 GB of memory (RAM)']),
    ', because it holds a lot more music in the background and uses noticeably more memory. ' +
      'The page will reload to apply the change.'
  ];
}

export interface PerformanceConfirmDialog {
  // Opens the explainer for a pending change. Nothing is persisted here; only on confirm do we call
  // onConfirm and reload the tab so the engine picks up the new predecode policy (it reads the
  // policy once at construction). Cancel leaves everything untouched.
  open(next: boolean, onConfirm: (next: boolean) => void): void;
  destroy(): void;
}

export function createPerformanceConfirmDialog(themeSource: HTMLElement): PerformanceConfirmDialog {
  const dialog: ConfirmDialog = createConfirmDialog(themeSource, 'High preloading');
  return {
    open(next, onConfirm) {
      dialog.open({
        title: next ? 'Switch to High preloading' : 'Leave High preloading',
        body: performanceConfirmBodyNodes(next),
        confirmLabel: next ? 'Use High & reload' : 'Apply & reload',
        onConfirm: () => {
          onConfirm(next);
          window.location.reload();
        }
      });
    },
    destroy() {
      dialog.destroy();
    }
  };
}
