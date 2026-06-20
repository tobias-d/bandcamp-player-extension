/* Bandcamp // Deck — landing page interactions
   Scroll reveals: elements fade + rise as they enter the viewport.
   Degrades gracefully and respects prefers-reduced-motion. */

(function () {
  'use strict';

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- scroll reveals ---------- */

  function initReveals() {
    if (reduceMotion || !('IntersectionObserver' in window)) {
      return; // content stays visible; no hidden state is applied
    }

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });

    // section-level blocks
    document.querySelectorAll(
      '.hero-text > *, .hero-shot, section > .side-label, section > h2, section > .lede, section > .cta-row'
    ).forEach(function (el) {
      el.classList.add('reveal');
      io.observe(el);
    });

    // cards, staggered within each grid
    document.querySelectorAll('.grid').forEach(function (grid) {
      Array.prototype.slice.call(grid.children).forEach(function (card, i) {
        card.classList.add('reveal');
        card.style.transitionDelay = Math.min(i * 60, 360) + 'ms';
        io.observe(card);
      });
    });
  }

  function init() {
    initReveals();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
