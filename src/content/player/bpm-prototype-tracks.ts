export interface BpmPrototypeTrackEntry {
  id: string;
  label: string;
  url: string;
  bucket: string;
  expectedBpm?: number;
  notes?: string;
  custom?: boolean;
}

const CUSTOM_TRACKS_STORAGE_KEY = '__BC_BPM_PROTOTYPE_CUSTOM_TRACKS__';

const DEFAULT_TRACKS: ReadonlyArray<BpmPrototypeTrackEntry> = [
  {
    id: 'ameeva-quasar-winds',
    label: 'Ameeva - Quasar Winds',
    url: 'https://lowless.bandcamp.com/track/quasar-winds',
    bucket: 'false-160-with-support',
    expectedBpm: 120,
    notes: 'Known false-160 case.'
  },
  {
    id: 'kanthor-modele',
    label: 'Kanthor - Modèle',
    url: 'https://lowless.bandcamp.com/track/mod-le',
    bucket: 'false-160-with-support',
    expectedBpm: 122,
    notes: 'Near-tie false-160 case.'
  },
  {
    id: 'sindh-koyul',
    label: 'Sindh - Koyul',
    url: 'https://lowless.bandcamp.com/track/koyul',
    bucket: 'weak-evidence-wrong-pulse',
    expectedBpm: 120,
    notes: 'Wrong-pulse overshoot target for segment voting.'
  },
  {
    id: 'sindh-miari',
    label: 'Sindh - Miari',
    url: 'https://lowless.bandcamp.com/track/miari',
    bucket: 'false-160-remapped-34',
    expectedBpm: 120,
    notes: 'High-160 miss with strong full-track 3/4 evidence but only remapped sparse support near 119.'
  },
  {
    id: 'bc-stream-2749840127',
    label: 'Bandcamp stream 2749840127 (Cior)',
    url: 'https://bandcamp.com/stream_redirect?enc=mp3-128&track_id=2749840127&ts=1773707600&t=c09e90647c2f104b835cb02dc11f4f159ea040a5',
    bucket: 'false-160-remapped-34',
    expectedBpm: 120,
    notes: 'High-160 miss with unanimous remapped-only 3/4 support and near-zero base resistance.'
  },
  {
    id: 'bluhol-recondition',
    label: 'bluhol - Recondition',
    url: 'https://siooqh.bandcamp.com/track/bluhol-recondition',
    bucket: 'true-high-control',
    expectedBpm: 156,
    notes: 'True-high control.'
  },
  {
    id: 'tibia-trampolin',
    label: 'Tibia - Trampolin',
    url: 'https://bodyverse1.bandcamp.com/track/trampolin',
    bucket: 'true-high-control',
    expectedBpm: 160,
    notes: 'Must stay high.'
  },
  {
    id: 'archypness-vessel-straight-mix',
    label: 'Archypness w/ Estrato Aurora & K.O.P. 32 - Vessel (Straight Mix)',
    url: 'https://obtuseswamp.bandcamp.com/track/vessel-straight-mix',
    bucket: 'true-160-near-tie-guardrail',
    expectedBpm: 160,
    notes: 'True-160 guardrail.'
  },
  {
    id: 'archypness-dark-green',
    label: 'Archypness w/ Estrato Aurora & K.O.P. 32 - Dark Green',
    url: 'https://obtuseswamp.bandcamp.com/track/dark-green',
    bucket: 'true-160-near-tie-guardrail',
    expectedBpm: 160,
    notes: 'True-160 guardrail.'
  },
  {
    id: 'siooqh-qi-pythia',
    label: 'Siooqh - Qi - Pythia',
    url: 'https://siooqh.bandcamp.com/track/qi-pythia',
    bucket: 'true-160-near-tie-guardrail',
    expectedBpm: 160,
    notes: 'True-160 guardrail.'
  },
  {
    id: 'siooqh-kennykrazyworld-bizoka',
    label: 'Siooqh - KennyKrazyWorld - Bizoka',
    url: 'https://siooqh.bandcamp.com/track/kennykrazyworld-bizoka',
    bucket: 'true-160-near-tie-guardrail',
    expectedBpm: 160,
    notes: 'True-160 guardrail.'
  },
  {
    id: 'blume-like-this',
    label: 'BLUME - like this?',
    url: 'https://materica.bandcamp.com/track/blume-like-this',
    bucket: 'true-160-near-tie-guardrail',
    expectedBpm: 160,
    notes: 'True-160 guardrail.'
  },
  {
    id: 'hwa-8xr',
    label: 'HWA - 8xr',
    url: 'https://materica.bandcamp.com/track/hwa-8xr',
    bucket: 'true-160-near-tie-guardrail',
    expectedBpm: 160,
    notes: 'True-160 guardrail.'
  },
  {
    id: 'bc-stream-2200592726',
    label: 'Ina Kacz - Authentic',
    url: 'https://onboardmusic.bandcamp.com/track/authentic',
    bucket: 'low-band-exact-miss',
    expectedBpm: 140,
    notes: 'Approximate ~140. Exact path keeps ~91 even with rhythm near 140.'
  },
  {
    id: 'bc-stream-1131063019',
    label: 'Bandcamp stream 1131063019',
    url: 'https://bandcamp.com/stream_redirect?enc=mp3-128&track_id=1131063019&ts=1773694828&t=bbbe5b80e9f4188ad56f905e7710bf3c2d15c612',
    bucket: 'low-band-provisional-recovers',
    expectedBpm: 138,
    notes: 'Fast path under-reads near 91; deferred refinement recovers to ~139.'
  },
  {
    id: 'bc-stream-2198503301',
    label: 'Bandcamp stream 2198503301',
    url: 'https://bandcamp.com/stream_redirect?enc=mp3-128&track_id=2198503301&ts=1773694518&t=71de459424d2c8e20bb3a09a4d36b3273c9d0239',
    bucket: 'low-band-provisional-recovers',
    expectedBpm: 128,
    notes: 'Fast path under-reads near 85; deferred refinement recovers to ~127.'
  },
  {
    id: 'bc-stream-2954984289',
    label: 'Bandcamp stream 2954984289',
    url: 'https://bandcamp.com/stream_redirect?enc=mp3-128&track_id=2954984289&ts=1773695074&t=6fa1f899318c1c4cfdb2a4d4cdf2164a9832cda6',
    bucket: 'low-band-exact-miss',
    expectedBpm: 138,
    notes: 'Exact path stays near 109 even though ear check is 138.'
  },
  {
    id: 'bc-stream-3474932498',
    label: 'Bandcamp stream 3474932498',
    url: 'https://bandcamp.com/stream_redirect?enc=mp3-128&track_id=3474932498&ts=1773694155&t=5d670836741db07133959f3c7b456f10a4c4cee2',
    bucket: 'low-band-exact-miss',
    expectedBpm: 138,
    notes: 'Exact path keeps ~86 despite repeated rhythm evidence around 138.'
  },
  {
    id: 'bc-stream-2919883343',
    label: 'Bandcamp stream 2919883343',
    url: 'https://bandcamp.com/stream_redirect?enc=mp3-128&track_id=2919883343&ts=1773593787&t=f37de5d7a0218983f0df546c83acd59584c231e4',
    bucket: 'low-band-false-promotion',
    expectedBpm: 85,
    notes: 'Counterexample: deferred exact path wrongly promotes 85 to 113.'
  },
  {
    id: 'bc-stream-1298762536',
    label: 'Local Analyst - Your Own Blood',
    url: 'https://codecrecordings.bandcamp.com/track/your-own-blood',
    bucket: 'low-band-exact-miss',
    expectedBpm: 131,
    notes: 'Boundary case: base stays at 87 while strong rhythm evidence lands at 131.'
  },
  {
    id: 'bc-stream-3114258437',
    label: 'Bandcamp stream 3114258437',
    url: 'https://bandcamp.com/stream_redirect?enc=mp3-128&track_id=3114258437&ts=1773695460&t=23def6c766b0f494c6f04857f2f84a31e7bb4fe4',
    bucket: 'low-band-pulse-lock',
    expectedBpm: 136,
    notes: 'Base, refinement, and prototype all lock to ~91 while ear check is ~136.'
  },
  {
    id: 'decoder-lutalica',
    label: 'Decoder - Lutalica',
    url: 'https://t4.bcbits.com/stream/5e58912724d421511aa3c6c1b9dbcde6/mp3-128/951395040?p=0&ts=1774107845&t=e1f83c2a74e2ddf93e4587aadca30a061c90d923&token=1774107845_e49b82fda6292a1c075a2405a19853127ad4064a',
    bucket: 'low-band-exact-miss',
    expectedBpm: 136,
    notes: 'Playlist preload settles near 109 while the reference BPM is 136.'
  },
  {
    id: 'decoder-kuhl',
    label: 'Decoder - Kuhl',
    url: 'https://t4.bcbits.com/stream/75a982d044b5b7629a4489a32f3760dc/mp3-128/2651863029?p=0&ts=1774107845&t=b007f6d3858800292d81e52803abbc9281d8313f&token=1774107845_a1427f91236fe52b9bfce8788d88af7d8c537253',
    bucket: 'low-band-pulse-lock',
    expectedBpm: 144,
    notes: 'Playlist preload falls to half-time ~72 while the reference BPM is 144.'
  },
  {
    id: 'irini-sweet-charlotte',
    label: 'irini - sweet charlotte',
    url: 'https://t4.bcbits.com/stream/884614e07327c655eeb2b045aaf8b597/mp3-128/393711612?p=0&ts=1774108356&t=5bb2bde636ae19975838e249b2aed8644320db78&token=1774108356_a658522b9642f3ceee9ff21f7a59d3f10c2be57c',
    bucket: 'true-high-control',
    expectedBpm: 168,
    notes: 'Playlist preload falls to half-time ~84 while the reference BPM is 168.'
  },
  {
    id: 'bc-stream-2032060153',
    label: 'Bandcamp stream 2032060153',
    url: 'https://bandcamp.com/stream_redirect?enc=mp3-128&track_id=2032060153&ts=1773695590&t=6eef33b09795223a73a18808ef52d3d754045e0b',
    bucket: 'low-band-provisional-recovers',
    expectedBpm: 134,
    notes: 'Fast path lands at 90; deferred refinement recovers to ~132.'
  },
  {
    id: 'holden-federico-crux',
    label: 'Holden Federico - Crux',
    url: 'https://holdenfederico.bandcamp.com/track/crux',
    bucket: 'rekordbox-offset-target',
    expectedBpm: 137,
    notes: 'Origin [SK11X038]. Rekordbox ground truth 137. Beat-grid precision target.'
  },
  {
    id: 'holden-federico-hemisphere',
    label: 'Holden Federico - Hemisphere',
    url: 'https://holdenfederico.bandcamp.com/track/hemisphere',
    bucket: 'rekordbox-offset-target',
    expectedBpm: 137,
    notes: 'Origin [SK11X038]. Rekordbox ground truth 137. Beat-grid precision target.'
  },
  {
    id: 'holden-federico-sustained-light',
    label: 'Holden Federico - Sustained Light',
    url: 'https://holdenfederico.bandcamp.com/track/sustained-light',
    bucket: 'rekordbox-offset-target',
    expectedBpm: 138,
    notes: 'Origin [SK11X038]. Rekordbox ground truth 138. Beat-grid precision target.'
  },
  {
    id: 'holden-federico-origin',
    label: 'Holden Federico - Origin',
    url: 'https://holdenfederico.bandcamp.com/track/origin',
    bucket: 'rekordbox-offset-target',
    expectedBpm: 139,
    notes: 'Origin [SK11X038]. Rekordbox ground truth 139. Beat-grid precision target.'
  }
];

function sanitizeCustomTrack(raw: Partial<BpmPrototypeTrackEntry> | null | undefined): BpmPrototypeTrackEntry | null {
  if (!raw) {
    return null;
  }
  const label = String(raw.label || '').trim();
  const url = String(raw.url || '').trim();
  if (!label || !url) {
    return null;
  }
  return {
    id: String(raw.id || `custom:${url}`),
    label,
    url,
    bucket: String(raw.bucket || 'custom').trim() || 'custom',
    expectedBpm: Number.isFinite(raw.expectedBpm) ? Number(raw.expectedBpm) : undefined,
    notes: String(raw.notes || '').trim() || undefined,
    custom: true
  };
}

export function getDefaultBpmPrototypeTracks(): BpmPrototypeTrackEntry[] {
  return DEFAULT_TRACKS.map((entry) => ({ ...entry }));
}

export function readCustomBpmPrototypeTracks(): BpmPrototypeTrackEntry[] {
  try {
    const raw = window.localStorage.getItem(CUSTOM_TRACKS_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as Array<Partial<BpmPrototypeTrackEntry>>;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((entry) => sanitizeCustomTrack(entry))
      .filter((entry): entry is BpmPrototypeTrackEntry => Boolean(entry));
  } catch {
    return [];
  }
}

export function writeCustomBpmPrototypeTracks(entries: ReadonlyArray<BpmPrototypeTrackEntry>): void {
  try {
    const sanitized = entries
      .map((entry) => sanitizeCustomTrack(entry))
      .filter((entry): entry is BpmPrototypeTrackEntry => Boolean(entry));
    window.localStorage.setItem(CUSTOM_TRACKS_STORAGE_KEY, JSON.stringify(sanitized));
  } catch {
    // Ignore storage failures in the debug-only prototype tool.
  }
}
