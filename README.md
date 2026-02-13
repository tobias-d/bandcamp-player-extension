# Bandcamp Player Extension

A browser extension that provides a floating player with BPM detection and waveform visualization for Bandcamp tracks.

![Screenshot](image.png)

## Features

- 🎵 **Floating Player Window** - Draggable, persistent player that stays on top while browsing
- 🎯 **Alternative BPM Analysis** - Autocorrelation-based tempo estimation with a different algorithmic approach
- 👆 **Manual BPM Tapper** - Simple tap-to-detect solution for tracks with complex rhythms or difficult-to-analyze material
- 📊 **3-Band Waveform Visualization** - Real-time display of low/mid/high frequency components
- 🎚️ **Playback Controls** - Play, pause, and track navigation in a compact interface

## Why Another Bandcamp Tool?

While other Bandcamp enhancement tools exist, this extension offers:

- **Floating window approach** - Unlike inline players, the floating window stays accessible across different pages and tabs
- **Different BPM detection algorithm** - Alternative analysis method that may work better for certain genres or production styles
- **Manual fallback option** - The BPM tapper provides a reliable way to detect tempo for material that's difficult to analyze automatically (polyrhythms, ambient tracks, experimental music, etc.)


## Installation


1. **Clone the repository:**
   ```bash
   git clone https://github.com/YOUR-USERNAME/bandcamp-player-extension.git
   cd bandcamp-player-extension
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Build the extension:**
   ```bash
   npm run build
   ```

4. **Load in Firefox:**
   - Open `about:debugging#/runtime/this-firefox`
   - Click "Load Temporary Add-on"
   - Select any file in the `dist/` folder



## License

MIT License - see LICENSE file for details

## Contributing

Contributions welcome! Please open an issue or submit a pull request.
