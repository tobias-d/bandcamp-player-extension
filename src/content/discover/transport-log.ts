import {
  recordDiscoverTransportAction,
  recordDiscoverTransportResult,
  type DiscoverTransportDebugState
} from '@/content/debug/debugger';
import { createLogger } from '@/utils/debug';

const logger = createLogger('DISCOVER');

export function recordTransportAction(
  transportDebug: DiscoverTransportDebugState,
  action: string,
  detail: string
): void {
  recordDiscoverTransportAction(transportDebug, action, detail);
  logger.info('transport action', { seq: transportDebug.actionSeq, action, detail });
}

export function recordTransportResult(
  transportDebug: DiscoverTransportDebugState,
  action: string,
  detail: string
): void {
  recordDiscoverTransportResult(transportDebug, action, detail);
  logger.info('transport result', { action, detail });
}
