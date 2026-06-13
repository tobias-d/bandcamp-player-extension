// Structured debug-trace model shared by the debug-body builders (producers) and the
// debug panel (consumer). The builders emit `DebugSection[]` directly so the panel never
// has to re-parse a flat string back into sections. See rules/debug-ui-rules.md.

export const SECTION_ORDER = [
  'context',
  'playback',
  'metadata',
  'analysis',
  'performance',
  'likes',
  'playlist',
  'resolver',
  'runtime',
  'handover',
  'transport',
  'general'
] as const;

export type DebugSectionId = (typeof SECTION_ORDER)[number];

export const SECTION_TITLES: Record<DebugSectionId, string> = {
  context: 'Context',
  playback: 'Playback',
  metadata: 'Metadata',
  analysis: 'Analysis',
  performance: 'Performance',
  likes: 'Likes',
  playlist: 'Playlist & Preload',
  resolver: 'Resolver',
  runtime: 'Runtime Preparation',
  handover: 'Playback Handover',
  transport: 'Transport & Bridge',
  general: 'Unclassified'
};

export interface DebugEntry {
  kind: 'heading' | 'entry' | 'text';
  label: string;
  value: string;
  raw: string;
  searchable: string;
}

export interface DebugSection {
  id: DebugSectionId;
  title: string;
  entries: DebugEntry[];
}

// Factory signature for the throttled debug push. Producers return the structured sections;
// the panel owns title and recent-message events separately.
export type DebugSectionsFactory = () => DebugSection[];

// Lines that begin with a wall-clock timestamp (`HH:MM:SS…`) are trace rows, not key/value
// pairs — without this guard the leading clock would be mis-split into a `13` label.
const TRACE_CLOCK_PREFIX = /^\d{1,2}:\d{2}:\d{2}/;

// Format a timestamp as a local-time `HH:MM:SS.mmm` trace clock. Single source of truth for
// every trace row's leading time, so all sections share one timezone.
export function formatTraceClock(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) {
    return '--:--:--.---';
  }
  const date = new Date(ts);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

// Classify a single pre-formatted debug line into an entry: heading = `Foo:` with no inline
// value, entry = `Label: value`, everything else (including timestamped trace rows) = free text.
export function classifyDebugLine(line: string): DebugEntry {
  const headingLike = line.endsWith(':') && !line.includes(': ');
  if (headingLike) {
    const label = line.slice(0, -1).trim();
    return { kind: 'heading', label, value: '', raw: line, searchable: label.toLowerCase() };
  }
  const colonIndex = line.indexOf(':');
  if (colonIndex > 0 && !TRACE_CLOCK_PREFIX.test(line)) {
    const label = line.slice(0, colonIndex).trim();
    const rawValue = line.slice(colonIndex + 1).trim();
    return {
      kind: 'entry',
      label,
      value: rawValue || '-',
      raw: line,
      searchable: `${label} ${rawValue}`.toLowerCase()
    };
  }
  return { kind: 'text', label: '', value: line, raw: line, searchable: line.toLowerCase() };
}

export interface DebugBuilder {
  section(id: DebugSectionId): DebugBuilder;
  line(raw: string): DebugBuilder;
  lines(raw: string[]): DebugBuilder;
  // Heading + trace rows, collapsed away entirely when the only row is the '(none)' sentinel
  // (matches the previous formatTraceSection behaviour).
  trace(title: string, rows: string[]): DebugBuilder;
  build(): DebugSection[];
}

export function createDebugBuilder(): DebugBuilder {
  const entriesBySection = new Map<DebugSectionId, DebugEntry[]>();
  let current: DebugSectionId = 'general';

  const push = (entry: DebugEntry): void => {
    const entries = entriesBySection.get(current) ?? [];
    entries.push(entry);
    entriesBySection.set(current, entries);
  };

  const builder: DebugBuilder = {
    section(id) {
      current = id;
      return builder;
    },
    line(raw) {
      // Mirror the old parser: trim trailing whitespace and drop blank lines.
      const trimmed = raw.replace(/\s+$/, '');
      if (trimmed) {
        push(classifyDebugLine(trimmed));
      }
      return builder;
    },
    lines(raw) {
      for (const entry of raw) {
        builder.line(entry);
      }
      return builder;
    },
    trace(title, rows) {
      if (rows.length === 1 && rows[0] === '(none)') {
        return builder;
      }
      builder.line(title);
      for (const row of rows) {
        builder.line(row);
      }
      return builder;
    },
    build() {
      return SECTION_ORDER.map((id) => {
        const entries = entriesBySection.get(id);
        return entries && entries.length
          ? { id, title: SECTION_TITLES[id], entries }
          : null;
      }).filter((section): section is DebugSection => Boolean(section));
    }
  };

  return builder;
}

// Machine-readable export of the current trace. Events are passed as pre-formatted lines so
// this module stays free of UI/event-formatting dependencies.
export function toDebugJSON(title: string, sections: DebugSection[], eventLines: string[]): string {
  return JSON.stringify(
    {
      title,
      capturedAt: new Date().toISOString(),
      sections: sections.map((section) => ({
        id: section.id,
        title: section.title,
        entries: section.entries.map((entry) => ({
          kind: entry.kind,
          label: entry.label,
          value: entry.value
        }))
      })),
      recentMessages: eventLines
    },
    null,
    2
  );
}
