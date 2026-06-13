import type { DebugEvent } from '@/shared/types';
import type { DebugEntry, DebugSection, DebugSectionId } from '@/shared/debug-trace';

// The structured trace model now lives in `@/shared/debug-trace` and is produced directly by
// the debug-body builders. These aliases keep the panel's historical names working.
export type DebugPanelSectionEntry = DebugEntry;
export type DebugPanelSection = DebugSection;

const ANONYMIZED_FULL_SECTION_IDS = new Set<DebugSectionId>([
  'playback',
  'analysis',
  'performance',
  'playlist',
  'resolver',
  'runtime'
]);

const ANONYMIZED_METADATA_PREFIXES = [
  'Metadata:',
  'Metadata confidence:',
  'Metadata sources:',
  'Metadata origin path:',
  'Metadata match:',
  'Metadata stream match:',
  'Metadata debug: linkedRelease=',
  'Metadata debug: domIdentity=',
  'Metadata debug: domDetails=',
  'Metadata debug: strictIdentity=',
  'Metadata debug: counters ',
  'Metadata debug: strictApi=',
  'Metadata debug: apiProbe=',
  'Metadata debug: lastDecision='
];

const ANONYMIZED_GENERAL_PREFIXES = [
  'Page type:',
  'Playback gate:',
  'Audio URL:',
  'Audio source summary:',
  'Audio element:',
  'Playback:',
  'Metadata:',
  'Signalsmith ',
  'Runtime ',
  'Audio incident:',
  'Playhead debug:',
  'Native seek:',
  'Native seek request:',
  'Native seek dispatch:',
  'Native seek lifecycle:',
  'Owned playback host:',
  'Owned playback phase:',
  'Owned playback engine:',
  'Owned playback detail:',
  'Owned playback origin currentSrc:',
  'Owned playback runtime currentSrc:',
  'Owned playback flags:',
  'Owned playback command:',
  'Owned playback audio event:',
  'Owned playback checked:',
  'Transport debug:',
  'Bridge selected:',
  'Bridge ownership:'
];

const ANONYMIZED_EVENT_TAGS = new Set<DebugEvent['tag']>([
  'AUDIO',
  'ANALYZER',
  'METADATA',
  'PLAYLIST'
]);

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

function stringifyEventArg(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function formatEventTime(ts: number): string {
  const date = new Date(ts);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(
    date.getMilliseconds(),
    3
  )}`;
}

export function formatEventMessage(event: DebugEvent): string {
  const raw = event.args.map((value) => stringifyEventArg(value)).join(' ');
  return raw.length > 500 ? `${raw.slice(0, 500)}…` : raw;
}

export function formatEventLine(event: DebugEvent): string {
  return `${formatEventTime(event.ts)} [${event.tag}] ${event.level.toUpperCase()} ${formatEventMessage(event)}`;
}

export function formatAudioIncidentSnapshotText(title: string, sections: DebugPanelSection[]): string {
  const audioRows: string[] = [];
  let capturingAudioText = false;
  for (const section of sections) {
    for (const entry of section.entries) {
      if (entry.kind === 'heading') {
        if (entry.label.startsWith('Audio incident')) {
          audioRows.push(`${entry.label}:`);
          capturingAudioText = true;
        } else {
          capturingAudioText = false;
        }
        continue;
      }
      if (entry.kind === 'entry' && entry.label.startsWith('Audio incident')) {
        audioRows.push(`${entry.label}: ${entry.value}`);
        capturingAudioText = true;
        continue;
      }
      if (entry.kind === 'entry') {
        if (
          capturingAudioText &&
          (
            entry.raw.includes('[audio-') ||
            entry.value.includes('[audio-')
          )
        ) {
          audioRows.push(entry.raw);
          continue;
        }
        capturingAudioText = false;
        continue;
      }
      if (
        entry.kind === 'text' &&
        (
          entry.value.includes('[audio-') ||
          entry.value === '(none)'
        ) &&
        capturingAudioText
      ) {
        audioRows.push(entry.value);
      }
    }
  }

  if (!audioRows.length) {
    return `${title.trim()}\n\nAudio incident\n(no audio incident data)`.trim();
  }

  return `${title.trim()}\n\nAudio incident\n${audioRows.join('\n')}`.trim();
}

function sanitizeAnonymizedUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.hostname === 'bandcamp.com' && url.pathname === '/stream_redirect') {
      const keptQuery = new URLSearchParams();
      ['enc', 'track_id'].forEach((key) => {
        const value = url.searchParams.get(key);
        if (value) {
          keptQuery.set(key, value);
        }
      });
      const query = keptQuery.toString();
      return `${url.origin}${url.pathname}${query ? `?${query}` : ''}`;
    }
    if (/^\/(?:album|track)\//.test(url.pathname)) {
      return `${url.origin}${url.pathname}`;
    }
    return `${url.origin}/[path omitted]`;
  } catch {
    return '[url omitted]';
  }
}

function sanitizeAnonymizedText(value: string): string {
  return String(value || '')
    .replace(/https?:\/\/[^\s|),\]]+/gi, (url) => sanitizeAnonymizedUrl(url))
    .replace(/\b(?:slug|fan_id|fanId|pageFanId|viewerFanId|viewer_username|fan_username|username|fan)=([^,\s|)]+)/gi, (match) =>
      `${match.slice(0, match.indexOf('='))}=[redacted]`
    )
    .replace(/\b(?:crumb|token|auth|authorization)=([^,\s|)]+)/gi, (match) =>
      `${match.slice(0, match.indexOf('='))}=[redacted]`
    )
    .replace(/\b(?:albumLike|like|albumInventory|trackInventory|viewAlbum|viewTrack|projection)=([^,\s|)]+)/gi, (match) =>
      `${match.slice(0, match.indexOf('='))}=[omitted]`
    )
    .replace(/\bmemory=[^,\s|)]+/gi, 'memory=[omitted]')
    .replace(/\bpolicy=memory-[^,\s|)]+/gi, 'policy=[omitted]')
    // Resource-diagnostics heap values correlate with device RAM, so omit them while keeping the
    // operational lag/busy/queue diagnostics in the same rows.
    .replace(/\b(?:heap|heapLimit|wasmHeap|essentiaHeap)=[^,\s|)]+/gi, (match) =>
      `${match.slice(0, match.indexOf('='))}=[omitted]`
    )
    .replace(/\/Users\/[^/\s]+/g, '/Users/[redacted]')
    .replace(/\/home\/[^/\s]+/g, '/home/[redacted]')
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+/gi, 'C:\\Users\\[redacted]');
}

function isAnonymizedEntryIncluded(section: DebugPanelSection, entry: DebugPanelSectionEntry): boolean {
  if (entry.kind === 'heading') {
    return false;
  }
  if (ANONYMIZED_FULL_SECTION_IDS.has(section.id)) {
    return true;
  }
  const prefixes = section.id === 'metadata'
    ? ANONYMIZED_METADATA_PREFIXES
    : ANONYMIZED_GENERAL_PREFIXES;
  return prefixes.some((prefix) => entry.raw.startsWith(prefix));
}

export function formatAnonymizedDebugText(
  title: string,
  sections: DebugPanelSection[],
  events: DebugEvent[]
): string {
  const reportSections = sections
    .map((section) => {
      const rows = section.entries
        .filter((entry) => isAnonymizedEntryIncluded(section, entry))
        .map((entry) => sanitizeAnonymizedText(entry.raw));
      return rows.length ? `${section.title}\n${rows.join('\n')}` : '';
    })
    .filter(Boolean);

  const recentMessages = events
    .filter((event) => ANONYMIZED_EVENT_TAGS.has(event.tag))
    .slice(-40)
    .map((event) => sanitizeAnonymizedText(formatEventLine(event)));
  if (recentMessages.length) {
    reportSections.push(`Recent Messages\n${recentMessages.join('\n')}`);
  }

  return [
    `${title.trim()} - Anonymized`,
    'Privacy filter: account, library, authentication, local-path, device-memory, browser-audio, and signed URL token data omitted.',
    ...reportSections
  ].join('\n\n').trim();
}
