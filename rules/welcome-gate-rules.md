# Welcome Gate Rules

**Scope:** the paged welcome overlay shown to first-time users and on version updates.
All code lives in `src/ui/components/welcome-gate.ts`.

## Layout

The gate is an absolute overlay filling the panel. The card is split into three fixed bands:

| Band | Flex basis | Contents |
|------|-----------|----------|
| Top | 25% | Title ("BANDCAMP // DECK") and version label |
| Mid | 50% | Slide content + dot indicator + back/next arrows |
| Bottom | 25% | SKIP / LET'S GO button |

A curved SVG background (`createWelcomeBackground`) draws the darker mid band and its two
divider lines from the same quadratic curves — do not separate the fill from the lines or
change the curve coordinates without updating both.

The slide region inside the mid band is `max-width: 255px`, vertically centered, and set to
`overflow-y: auto` as a last resort. **Slides must not require scrolling under normal
conditions.** If a new slide causes overflow at the default panel size, shorten the content —
do not rely on scroll.

## Slides

Slides are built in `buildWelcomePages()` and returned in order. The dot indicator, back/next
arrows, and SKIP/LET'S GO button are driven entirely by array index — order in the return
array is the display order.

**Current slides (in order):**

1. **DJ / Lite mode** — announcement slide (NEW badge) for the DJ↔Lite switch. First slide; ask the user before removing it.
2. **Appearance** — resize gesture, Appearance setting (opacity + background pattern).
3. **Preload tracks** — the Off/Normal/High control (NEW badge); High is Chrome-only.
4. **Key analysis** — off by default, differs from Rekordbox/Mixed In Key.
5. **Keyboard shortcuts** — default key mapping grid (transport left, playback/tempo right).
6. **Feedback** — bug report link, tip link. Always the last slide.

Keep this list in sync with the code whenever slides are added, removed, or reordered.

## Content Rules

- **Audience is first-time users.** Each slide answers "what does this do and why do I care?"
  in the fewest words possible. No implementation detail, no jargon without a brief definition.
- **Space budget is tight.** Two to three short items per slide is the maximum. Prefer a
  single feature chip + one sentence over a long paragraph.
- **Content must match the real codebase.** Every feature chip name, setting label, and
  described behaviour must correspond to something that actually exists and works. Before
  editing slide content, verify the feature is present and behaves as described.
- The `is-tight` class (`gap: 2px`) is available for slides that need rows closer together;
  the default page gap is `8px`. Use `is-tight` only when the content genuinely fits tighter
  and does not look cramped.
- Injected elements that are not divs or spans (`<p>`, `<li>`) must carry explicit
  `margin: 0; padding: 0` in their CSS rules — Bandcamp's page stylesheet leaks default
  block margins into the injected DOM.

## Update Announcement Pattern

When a significant new feature ships, a dedicated announcement slide is inserted **before the
current first slide** (index 0), pushing the existing slides down by one position. It uses the
same page/chip/text building blocks as other slides.

The **NEW badge** (`bc-welcome-gate-feature-new`, green) can be added to any existing slide to
call out a changed or added detail within that slide — it does not require a new slide.

**Badge and announcement slide lifecycle:** there is no automatic rule. Always ask the user
when a NEW badge or announcement slide should be removed. Do not remove either on your own.

## Feedback Slide

The Feedback slide is currently always last and its content (bug report + tip links) is stable.
This is a convention, not a hard constraint — the user may reorder or change it explicitly.

## Verification

The welcome gate is injected UI — changes are shared source. Run both production builds after
any change:

```
npm run build
npm run build:chrome
```

To force the welcome gate to reappear during testing, clear both storage locations:

```js
// In the page console on a Bandcamp tab:
localStorage.removeItem('bc:welcome:last-seen-version:v3');
// In the extension service-worker console:
chrome.storage.local.remove('bc:welcome:last-seen-version:v3');
```
