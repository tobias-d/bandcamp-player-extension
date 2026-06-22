import type { GlassSettings } from '@/ui/glass/glass-settings';

const SVG_NS = 'http://www.w3.org/2000/svg';
const FILTER_ID = 'bc-panel-glass-filter';

/** Must match the .bc-panel-root border-radius in panel-shell.ts. */
const PANEL_CORNER_RADIUS = 14;

export interface PanelGlassController {
  apply(settings: GlassSettings): void;
  destroy(): void;
}

/**
 * Signed distance from point (px,py) to the edge of a w×h rounded rectangle
 * with corner radius r (negative inside). Standard rounded-box SDF; its
 * gradient is the outward surface normal we displace along.
 */
function roundedRectSdf(px: number, py: number, w: number, h: number, r: number): number {
  const qx = Math.abs(px - w / 2) - (w / 2 - r);
  const qy = Math.abs(py - h / 2) - (h / 2 - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

/**
 * Builds the displacement map for the panel as the superposition of two
 * vector fields, encoded in R (x) / G (y), 128 = zero (kube.io convention):
 *
 * 1. Bezel: inside the edge band, displacement along the outward SDF normal,
 *    magnitude rising toward the rim with a convex profile — the edge bends
 *    the backdrop like thick curved glass.
 * 2. Centre lens: the panel face is the centre window of a much larger
 *    virtual lens, so only the smooth inner bulge is visible — there is no
 *    rim/discontinuity anywhere in view. Displacement is radially outward,
 *    zero at the centre, growing with a squircle-shaped radius (so the
 *    distortion follows the panel's rectangular shape instead of fading at
 *    the long edges) and reaching the slider value at the corners.
 *
 * feDisplacementMap has a single global scale, so each field is baked in
 * weighted by its own strength relative to scaleMax (the value the caller
 * sets as the scale attribute). The superposed vector is clamped per axis.
 */
function buildDisplacementMap(
  width: number,
  height: number,
  bezelWidth: number,
  refraction: number,
  lens: number,
  scaleMax: number
): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return '';
  }
  const radius = Math.min(PANEL_CORNER_RADIUS, width / 2, height / 2);
  const image = ctx.createImageData(width, height);
  const data = image.data;
  const eps = 0.5;
  const bezelWeight = refraction / scaleMax;
  const lensWeight = lens / scaleMax;
  const hx = width / 2;
  const hy = height / 2;
  // Squircle radius is 2^(1/4) at the panel corners; dividing by this puts
  // the profile's maximum (= the slider value) exactly at the corners.
  const cornerNorm = Math.pow(2, 0.25);

  let i = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++, i += 4) {
      const px = x + 0.5;
      const py = y + 0.5;
      let vx = 0;
      let vy = 0;

      const inset = -roundedRectSdf(px, py, width, height, radius);
      if (bezelWeight !== 0 && inset < bezelWidth) {
        // 0 at the band's inner boundary -> 1 at the glass edge.
        const t = 1 - Math.max(inset, 0) / bezelWidth;
        // Convex profile: displacement concentrated at the rim, easing to zero
        // inward, approximating the squircle surface slope used by kube.io.
        const m = Math.pow(t, 2.5);
        // Outward normal from the SDF gradient (numerical, eps=0.5px).
        const nx = roundedRectSdf(px + eps, py, width, height, radius) - roundedRectSdf(px - eps, py, width, height, radius);
        const ny = roundedRectSdf(px, py + eps, width, height, radius) - roundedRectSdf(px, py - eps, width, height, radius);
        const len = Math.hypot(nx, ny);
        if (len > 0) {
          vx += bezelWeight * m * (nx / len);
          vy += bezelWeight * m * (ny / len);
        }
      }

      if (lensWeight !== 0) {
        const dx = px - hx;
        const dy = py - hy;
        // Squircle (4-norm) radius: 0 at the centre, 1 at edge midpoints,
        // 2^(1/4) at corners — iso-curves follow the panel's rectangle.
        const nx4 = Math.pow(dx / hx, 4);
        const ny4 = Math.pow(dy / hy, 4);
        const rho = Math.pow(nx4 + ny4, 0.25) / cornerNorm;
        if (rho > 0) {
          // Smooth power-law bulge: flat centre, strongest at the corners,
          // monotonic throughout — no lens rim anywhere in view.
          const m = Math.pow(rho, 2.5);
          const len = Math.hypot(dx, dy);
          vx += lensWeight * m * (dx / len);
          vy += lensWeight * m * (dy / len);
        }
      }

      // Per-axis clamp where the two fields overlap and exceed scaleMax.
      vx = Math.min(1, Math.max(-1, vx));
      vy = Math.min(1, Math.max(-1, vy));
      data[i] = Math.round(128 + vx * 127);
      data[i + 1] = Math.round(128 + vy * 127);
      data[i + 2] = 128;
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL('image/png');
}

/**
 * Owns the liquid-glass surface of the panel root.
 *
 * Both browsers: tint, blur, saturation and the specular rim are driven by CSS
 * custom properties on the root (stylesheet: panel-shell.ts / glass.ts).
 *
 * Chrome only: the backdrop additionally runs through an inline SVG filter
 * (blur -> saturate -> edge displacement) referenced from backdrop-filter, so
 * the panel edge refracts the page behind it. Chromium is the only engine that
 * applies SVG filters in backdrop-filter; on Firefox the stylesheet's plain
 * blur()/saturate() backdrop-filter stays in effect and there is no refraction.
 * Blur/saturate live inside the SVG chain on Chrome because mixing url() with
 * function filters in one backdrop-filter list is unreliable in Chromium.
 */
export function createPanelGlass(root: HTMLElement): PanelGlassController {
  // Grey camouflage dapple: a pointer-transparent layer below the content whose
  // opacity / blur / brightness are driven by --glass-camo* (see GLASS_CSS).
  // Appended before the rim so it sits underneath everything else.
  const camo = document.createElement('div');
  camo.className = 'bc-glass-camo';
  camo.setAttribute('aria-hidden', 'true');
  root.appendChild(camo);

  // Specular rim light: a pointer-transparent overlay whose inset highlights
  // are scaled by --glass-specular (see GLASS_CSS).
  const rim = document.createElement('div');
  rim.className = 'bc-glass-rim';
  rim.setAttribute('aria-hidden', 'true');
  root.appendChild(rim);

  let svg: SVGSVGElement | null = null;
  let blurPrimitive: SVGFEGaussianBlurElement | null = null;
  let mapImage: SVGFEImageElement | null = null;
  let displacement: SVGFEDisplacementMapElement | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let rebuildFrame = 0;
  let lastBezel = 0;
  let lastRefraction = 0;
  let lastLens = 0;
  let lastMapWidth = 0;
  let lastMapHeight = 0;

  // The single feDisplacementMap scale both fields are normalised against.
  const scaleMax = (): number => Math.max(Math.abs(lastRefraction), Math.abs(lastLens)) || 1;

  const rebuildMap = (): void => {
    if (!mapImage || lastBezel <= 0) {
      return;
    }
    const width = root.offsetWidth;
    const height = root.offsetHeight;
    if (width < 1 || height < 1) {
      return;
    }
    if (width === lastMapWidth && height === lastMapHeight) {
      return;
    }
    lastMapWidth = width;
    lastMapHeight = height;
    const href = buildDisplacementMap(width, height, lastBezel, lastRefraction, lastLens, scaleMax());
    mapImage.setAttribute('href', href);
    mapImage.setAttribute('width', String(width));
    mapImage.setAttribute('height', String(height));
    // Set together with the map it normalises, so they can never disagree.
    displacement?.setAttribute('scale', String(scaleMax()));
  };

  const scheduleRebuild = (): void => {
    if (rebuildFrame) {
      return;
    }
    rebuildFrame = window.requestAnimationFrame(() => {
      rebuildFrame = 0;
      rebuildMap();
    });
  };

  if (__BUILD_TARGET__ === 'chrome') {
    const doc = root.ownerDocument;
    svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.style.position = 'absolute';
    svg.style.width = '0';
    svg.style.height = '0';
    svg.style.overflow = 'hidden';
    svg.style.pointerEvents = 'none';

    const filter = doc.createElementNS(SVG_NS, 'filter');
    filter.setAttribute('id', FILTER_ID);
    filter.setAttribute('x', '0');
    filter.setAttribute('y', '0');
    filter.setAttribute('width', '100%');
    filter.setAttribute('height', '100%');
    // sRGB so the 0..255 map channels are read literally, not gamma-shifted.
    filter.setAttribute('color-interpolation-filters', 'sRGB');

    blurPrimitive = doc.createElementNS(SVG_NS, 'feGaussianBlur') as SVGFEGaussianBlurElement;
    blurPrimitive.setAttribute('in', 'SourceGraphic');
    blurPrimitive.setAttribute('result', 'frost');

    mapImage = doc.createElementNS(SVG_NS, 'feImage') as SVGFEImageElement;
    mapImage.setAttribute('x', '0');
    mapImage.setAttribute('y', '0');
    mapImage.setAttribute('preserveAspectRatio', 'none');
    mapImage.setAttribute('result', 'bezelMap');

    displacement = doc.createElementNS(SVG_NS, 'feDisplacementMap') as SVGFEDisplacementMapElement;
    displacement.setAttribute('in', 'frost');
    displacement.setAttribute('in2', 'bezelMap');
    displacement.setAttribute('xChannelSelector', 'R');
    displacement.setAttribute('yChannelSelector', 'G');

    filter.appendChild(blurPrimitive);
    filter.appendChild(mapImage);
    filter.appendChild(displacement);
    svg.appendChild(filter);
    root.appendChild(svg);

    // Replace the stylesheet's plain blur/saturate backdrop with the SVG chain.
    root.style.setProperty('backdrop-filter', `url(#${FILTER_ID})`);
    root.style.setProperty('-webkit-backdrop-filter', `url(#${FILTER_ID})`);

    // Panel height changes with content (playlist, tap panel, ...), and the map
    // must match the element size 1:1, so rebuild on resize. The observer also
    // fires once on observe, which produces the initial map after the root is
    // attached. rAF-coalesced so a burst of resize notifications yields one
    // rebuild per frame at most.
    resizeObserver = new ResizeObserver(scheduleRebuild);
    resizeObserver.observe(root);
  }

  return {
    apply(settings: GlassSettings): void {
      root.style.setProperty('--glass-tint', String(settings.tint));
      root.style.setProperty('--glass-specular', String(settings.specular));
      // Camouflage layer is engine-agnostic (plain CSS), so it is driven the
      // same way on both browsers, outside the Chrome SVG branch below. The
      // switch toggles the whole layer by collapsing its opacity to 0.
      root.style.setProperty('--glass-camo', settings.camoEnabled ? String(settings.camo) : '0');
      root.style.setProperty('--glass-camo-blur', `${settings.camoBlur}px`);
      root.style.setProperty('--glass-camo-tone', String(settings.camoTone));
      if (__BUILD_TARGET__ === 'chrome') {
        // CSS blur(v) is defined as a Gaussian with stdDeviation = v, so the
        // slider value transfers 1:1 between the Firefox CSS path and this one.
        blurPrimitive?.setAttribute('stdDeviation', String(settings.blur));
        // Refraction and lens strengths are baked into the map (weighted
        // against scaleMax), so any of the three parameters changing requires
        // a map rebuild — rAF-coalesced, so slider drags cost one rebuild per
        // frame at most.
        if (settings.bezel !== lastBezel || settings.refraction !== lastRefraction || settings.lens !== lastLens) {
          lastBezel = settings.bezel;
          lastRefraction = settings.refraction;
          lastLens = settings.lens;
          lastMapWidth = 0;
          scheduleRebuild();
        }
      } else {
        root.style.setProperty('--glass-blur', `${settings.blur}px`);
      }
    },
    destroy(): void {
      if (rebuildFrame) {
        window.cancelAnimationFrame(rebuildFrame);
        rebuildFrame = 0;
      }
      resizeObserver?.disconnect();
      svg?.remove();
      rim.remove();
      camo.remove();
      root.style.removeProperty('backdrop-filter');
      root.style.removeProperty('-webkit-backdrop-filter');
    }
  };
}
