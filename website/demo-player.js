// Live panel demo: real track data for Origin [SK11X038], stacked 3-band
// waveform render, track switching wired to Bandcamp's official embed.
(function () {
  const tracks = ORIGIN_DATA.tracks;
  let current = 0;

  const fmt = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  // --- waveform: stacked low/mid/high fills, extension v6.2 palette ---
  const canvas = document.getElementById('bcd-wave');
  const ctx = canvas.getContext('2d');

  function drawWave(t) {
    const { low, mid, high } = t.env;
    const W = canvas.width, H = canvas.height, n = low.length;
    // resample buckets to one value per pixel column (box average) to
    // avoid moiré when the canvas is narrower than the bucket count
    const col = band => {
      const out = new Array(W);
      for (let x = 0; x < W; x++) {
        const a = Math.floor(x / W * n), b = Math.max(a + 1, Math.floor((x + 1) / W * n));
        let s = 0;
        for (let i = a; i < b; i++) s += band[i];
        out[x] = s / (b - a);
      }
      return out;
    };
    const L = col(low), M = col(mid), Hi = col(high);
    let maxSum = 1;
    for (let x = 0; x < W; x++) maxSum = Math.max(maxSum, L[x] + M[x] + Hi[x]);
    ctx.clearRect(0, 0, W, H);
    const layer = (sum, color) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(0, H);
      for (let x = 0; x < W; x++) ctx.lineTo(x, H - sum(x) / maxSum * (H - 6));
      ctx.lineTo(W, H);
      ctx.closePath();
      ctx.fill();
    };
    layer(x => L[x] + M[x] + Hi[x], '#b5a9e2');
    layer(x => L[x] + M[x], '#7e6fb4');
    layer(x => L[x], '#4e4470');
  }

  // --- track switching ---
  // The official embed is sealed (no track-change events out, no commands
  // in), so sync runs panel -> embed: selecting a track here reloads the
  // embed with that track preselected.
  const rowsEl = document.getElementById('bcd-rows');
  const embed = document.getElementById('bcd-embed');

  function select(i, swapEmbed) {
    current = i;
    const t = tracks[i];
    document.getElementById('bcd-track-title').textContent = t.title;
    document.getElementById('bcd-bpm').textContent = t.bpm;
    document.getElementById('bcd-time').textContent = fmt(t.duration);
    drawWave(t);
    [...rowsEl.children].forEach((tr, k) => tr.classList.toggle('on', k === i));
    if (swapEmbed) {
      embed.src = `https://bandcamp.com/EmbeddedPlayer/v=2/album=${ORIGIN_DATA.albumId}/track=${t.id}/size=large/bgcol=f3f2f0/linkcol=7c6bb8/tracklist=true/transparent=true/`;
    }
  }

  tracks.forEach((t, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td class="c-num">${t.num}</td>` +
      `<td class="c-title">${t.title}</td>` +
      `<td class="c-bpm">${t.bpm}</td>` +
      `<td class="c-t">${fmt(t.duration)}</td>` +
      `<td class="c-ic"><span class="bcd-heart" title="Wishlist sync works in the extension">&#9829;</span>` +
      `<a class="bcd-ext" href="${t.url}" title="Open on Bandcamp">&#8599;</a></td>`;
    tr.addEventListener('click', e => {
      if (e.target.closest('a')) return;
      select(i, true);
    });
    rowsEl.appendChild(tr);
  });

  select(0, false);
})();
