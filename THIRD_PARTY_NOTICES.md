# Third-Party Notices

This project bundles third-party software as part of its build output.

## Lexend

- Upstream: `https://github.com/google/fonts/tree/main/ofl/lexend`
- Project page: `https://fonts.google.com/specimen/Lexend`
- License: `OFL-1.1`
- Designers: Thomas Jockin, Bonnie Shaver-Troup
- Bundled files: `src/assets/fonts/Lexend-Variable.ttf`, `src/assets/fonts/Lexend-OFL.txt`

How it is used in this project:

- Lexend is used as a bundled display font for the idle `BANDCAMP // DECK` player label.
- The build copies the font and license into `public/fonts/` so the injected player UI can load it from the extension package.

License notice:

Lexend is licensed under the SIL Open Font License, Version 1.1. The bundled license text is included at `src/assets/fonts/Lexend-OFL.txt`.

## Signalsmith Stretch / signalsmith-stretch

- Upstream: `https://github.com/Signalsmith-Audio/signalsmith-stretch`
- Project page: `https://signalsmith-audio.co.uk/code/stretch/`
- Package: `https://www.npmjs.com/package/signalsmith-stretch`
- License: `MIT`
- Version: `1.3.2`
- Author: Geraint Luff / Signalsmith Audio

How it is used in this project:

- Signalsmith Stretch powers the time-stretching used for Tempo Adjust.
- The project bundles the upstream `SignalsmithStretch.mjs` runtime module.
- The build also generates and ships a static worklet at `public/signalsmith/worklet.js`
  so the extension runtime can load the processor from an extension URL instead of
  relying on blob-based worklet loading.

License notice:

Signalsmith Stretch is licensed under the MIT License.

MIT License

Copyright (c) Geraint Luff

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Essentia / essentia.js

- Upstream (C++ library): `https://github.com/MTG/essentia`
- Upstream (JS bindings): `https://github.com/MTG/essentia.js`
- Homepage: `https://essentia.upf.edu/`
- License: `AGPL-3.0`
- Version: Essentia C++ 2.1-beta6-dev (master), essentia.js bindings 0.1.3

How it is used in this project:

- Essentia provides the audio analysis algorithms (BPM, key, spectral analysis).
- The extension ships a custom WASM build compiled from Essentia C++ source via Emscripten, using the essentia.js embind bindings.
- The custom build lives in `vendor/essentia-wasm-custom/` and is copied over the npm-installed files at build time.
- Build source and instructions: `~/essentia-wasm-build/` and `docs/essentia-wasm-rebuild-plan.md`.

Upstream attribution:

- Essentia C++ library: Music Technology Group (MTG), Universitat Pompeu Fabra
- essentia.js bindings: Albin Correya, MTG, Universitat Pompeu Fabra

License notice:

Both Essentia and essentia.js are licensed under the GNU Affero General Public License v3.0 (`AGPL-3.0`). This project is therefore licensed under AGPL-3.0-or-later to comply with the copyleft requirements. The full AGPL-3.0 license text is in the `LICENSE` file at the project root.
