import { dom } from '@/utils/dom';
import { createConfirmDialog, ConfirmDialog } from '@/ui/components/confirm-dialog';

// Chrome-only confirm dialog for the Performance-mode toggle. It is a thin wrapper over the shared
// confirm-dialog modal; only the perf-specific copy, button labels, and the reload-on-confirm live
// here.

// Body content is built from nodes (not a flat string) so the RAM requirement can be bold.
function performanceConfirmBodyNodes(next: boolean): (string | Node)[] {
  if (!next) {
    return ['This switches back to normal memory use. The page will reload to apply the change.'];
  }
  return [
    'Performance mode loads more of your playlist ahead of time, so jumping between tracks and ' +
      'skipping around stays instant even in long lists. ',
    dom('strong', {}, ['Only turn this on if your computer has at least 16 GB of memory (RAM)']),
    ', because it keeps a lot more music ready in the background and uses noticeably more memory. ' +
      'The page will reload to apply the change.'
  ];
}

export interface PerformanceConfirmDialog {
  // Opens the explainer for a pending change. The toggle is not flipped/persisted here; only on
  // confirm do we call onConfirm and reload the tab so the engine picks up the new predecode policy
  // (it reads the policy once at construction). Cancel leaves everything untouched.
  open(next: boolean, onConfirm: (next: boolean) => void): void;
  destroy(): void;
}

export function createPerformanceConfirmDialog(themeSource: HTMLElement): PerformanceConfirmDialog {
  const dialog: ConfirmDialog = createConfirmDialog(themeSource, 'Performance mode');
  return {
    open(next, onConfirm) {
      dialog.open({
        title: 'Performance mode',
        body: performanceConfirmBodyNodes(next),
        confirmLabel: next ? 'Enable & reload' : 'Disable & reload',
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
