const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const projectRoot = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(projectRoot, 'src/ui/media-session.ts'), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
});

// Exercise the shipped controller with a browser API double. Hardware routing
// and audio focus still need a real Chrome/Firefox smoke test.
function setup({ available = true, unsupportedAction } = {}) {
  let input = { isPlaying: false, metadata: { trackTitle: 'Track', artistName: 'Artist', albumTitle: 'Album' } };
  let valid = true;
  let invalidate;
  const events = new Map();
  const calls = [];
  const actions = new Map();
  const mediaSession = {
    playbackState: 'none',
    metadata: null,
    setActionHandler(action, handler) {
      if (action === unsupportedAction) {
        throw new DOMException('Unsupported action', 'NotSupportedError');
      }
      calls.push([action, handler]);
      if (handler) actions.set(action, handler);
      else actions.delete(action);
    }
  };
  const exports = {};
  vm.runInNewContext(outputText, {
    exports,
    navigator: { mediaSession: available ? mediaSession : undefined },
    MediaMetadata: function (metadata) { Object.assign(this, metadata); },
    DOMException,
    window: {
      addEventListener: (event, listener) => events.set(event, listener),
      removeEventListener: (event, listener) => {
        if (events.get(event) === listener) events.delete(event);
      }
    },
    require(name) {
      assert.equal(name, '@/utils/extension-context');
      return {
        isExtensionContextValid: () => valid,
        onExtensionContextInvalidated: (listener) => {
          invalidate = listener;
          return () => { invalidate = undefined; };
        }
      };
    }
  });
  const dispatched = [];
  const controller = exports.createPanelMediaSessionController({
    isPlaybackActive: () => input.isPlaying,
    onTogglePlayPause: () => dispatched.push('pause'),
    onPrevTrack: () => dispatched.push('previous'),
    onNextTrack: () => dispatched.push('next')
  });
  return {
    controller, mediaSession, actions, calls, dispatched, events,
    setPlaying(isPlaying, sync = true) {
      input = { ...input, isPlaying };
      if (sync) controller.sync(input);
    },
    invalidate(notify = true) {
      valid = false;
      if (notify) invalidate();
    }
  };
}

function assertReleased(state) {
  assert.equal(state.actions.size, 0);
  assert.equal(state.mediaSession.playbackState, 'none');
  assert.equal(state.mediaSession.metadata, null);
}

test('every manifest leaves hardware media and volume keys unreserved', () => {
  for (const name of ['manifest.json', 'manifest.firefox.json', 'manifest.firefox.dev.json']) {
    const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'src', name), 'utf8'));
    for (const name of Object.keys(manifest.commands || {})) {
      assert.doesNotMatch(name, /^media-/);
    }
    for (const command of Object.values(manifest.commands || {})) {
      assert.doesNotMatch(JSON.stringify(command.suggested_key || ''), /Media|Volume/);
    }
  }
});

test('player owner check rejects stale origin snapshots and inactive runtime/selection states', () => {
  const playerSource = fs.readFileSync(path.join(projectRoot, 'src/content/player/panel-handlers.ts'), 'utf8');
  const { outputText } = ts.transpileModule(playerSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  });
  const exports = {};
  vm.runInNewContext(outputText, {
    exports,
    require: (name) => name === '@/utils/debug' ? { createLogger: () => ({}) } : {}
  });
  const audio = { src: 'track.mp3', paused: true, ended: false };
  const state = {
    hasPlaybackStarted: true,
    runtimePlaylistSelectionPending: false,
    runtimePlaybackOwned: false,
    detachedPlaybackActive: false,
    bridgeAudioState: { src: 'track.mp3', paused: false }
  };
  const handlers = exports.createPlayerPanelHandlers({
    state,
    getBridge: () => ({ getActiveAudio: () => audio })
  });
  assert.equal(handlers.isPlaybackActive(), false, 'paused native owner overrides an old playing snapshot');
  audio.paused = false;
  assert.equal(handlers.isPlaybackActive(), true);
  state.runtimePlaybackOwned = true;
  state.bridgeAudioState.paused = true;
  assert.equal(handlers.isPlaybackActive(), false, 'paused runtime overrides native audio');
  state.bridgeAudioState.paused = false;
  assert.equal(handlers.isPlaybackActive(), true);
  state.runtimePlaylistSelectionPending = true;
  assert.equal(handlers.isPlaybackActive(), false);
  state.runtimePlaylistSelectionPending = false;
  state.hasPlaybackStarted = false;
  assert.equal(handlers.isPlaybackActive(), false, 'preparation does not open the playback gate');
});

test('creating and syncing an idle panel does not touch the page media session', () => {
  const state = setup();
  const nativeMetadata = { title: 'Native Bandcamp metadata' };
  state.mediaSession.metadata = nativeMetadata;
  state.setPlaying(false);
  state.controller.destroy();
  assert.equal(state.calls.length, 0);
  assert.equal(state.mediaSession.metadata, nativeMetadata);
});

test('playing registers only pause, previous, and next; metadata follows the track', () => {
  const state = setup();
  state.setPlaying(true);
  assert.deepEqual([...state.actions.keys()], ['pause', 'previoustrack', 'nexttrack']);
  assert.equal(state.mediaSession.playbackState, 'playing');
  assert.equal(state.mediaSession.metadata.title, 'Track');
  state.actions.get('previoustrack')();
  state.actions.get('nexttrack')();
  assert.deepEqual(state.dispatched, ['previous', 'next']);
  state.setPlaying(true);
  assert.equal(state.calls.length, 3, 'playing ticks must not reregister handlers');
});

test('hardware pause releases handlers before dispatch and cannot toggle back to playing', () => {
  const state = setup();
  state.setPlaying(true);
  const pause = state.actions.get('pause');
  pause();
  assertReleased(state);
  state.setPlaying(true);
  assertReleased(state);
  pause();
  assert.deepEqual(state.dispatched, ['pause']);
  state.setPlaying(false);
  state.setPlaying(true);
  assert.equal(state.actions.size, 3, 'UI playback after confirmed pause can register again');
});

test('pause/end/pending selection releases the session and ignores queued actions', () => {
  const state = setup();
  state.setPlaying(true);
  const queued = [...state.actions.values()];
  state.setPlaying(false);
  assertReleased(state);
  queued.forEach((callback) => callback());
  assert.deepEqual(state.dispatched, []);
});

test('a stopped playback getter blocks an action even before the next sync', () => {
  const state = setup();
  state.setPlaying(true);
  const next = state.actions.get('nexttrack');
  state.setPlaying(false, false);
  next();
  assertReleased(state);
  assert.deepEqual(state.dispatched, []);
});

test('resuming from the UI registers again but old callbacks cannot affect the new session', () => {
  const state = setup();
  state.setPlaying(true);
  const oldPause = state.actions.get('pause');
  state.setPlaying(false);
  state.setPlaying(true);
  oldPause();
  assert.equal(state.actions.size, 3);
  assert.deepEqual(state.dispatched, []);
  state.actions.get('nexttrack')();
  assert.deepEqual(state.dispatched, ['next']);
});

test('extension invalidation releases controls and prevents reacquiring them', () => {
  const state = setup();
  state.setPlaying(true);
  state.invalidate();
  assertReleased(state);
  state.setPlaying(true);
  assertReleased(state);
});

test('a callback detects an orphaned extension without needing an invalidation notification', () => {
  const state = setup();
  state.setPlaying(true);
  const previous = state.actions.get('previoustrack');
  state.invalidate(false);
  previous();
  assertReleased(state);
  assert.deepEqual(state.dispatched, []);
});

test('pagehide and destroy release controls; destroyed controllers stay inactive', () => {
  const state = setup();
  state.setPlaying(true);
  state.events.get('pagehide')();
  assertReleased(state);
  state.controller.destroy();
  state.setPlaying(true);
  assertReleased(state);
  assert.equal(state.events.size, 0);
});

test('missing Media Session support leaves hardware keys alone', () => {
  const state = setup({ available: false });
  state.setPlaying(true);
  state.controller.destroy();
  assert.equal(state.calls.length, 0);
  assert.deepEqual(state.dispatched, []);
});

test('unsupported actions are omitted without replacing them with extension shortcuts', () => {
  const state = setup({ unsupportedAction: 'previoustrack' });
  state.setPlaying(true);
  assert.deepEqual([...state.actions.keys()], ['pause', 'nexttrack']);
  state.setPlaying(false);
  assertReleased(state);
});
