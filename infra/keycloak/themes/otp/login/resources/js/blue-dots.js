/* Blue Dots — animated particle network for the Keycloak login hero panel.
 * Mirrors the canvas implementation in apps/web/src/app/(public)/login/LoginView.tsx
 * so the Next.js portal and Keycloak login share an identical visual.
 */
(function () {
  'use strict';

  // Palette pulled from CSS vars at boot so the canvas matches whatever
  // brand the active deployment ships. Particle/link colors are mixed
  // toward white before use — mirrors the aggregator web BrandPanel
  // (`mix(primary, '#FFFFFF', 0.5)` for soft, `mix(accent, '#FFFFFF',
  // 0.4)` for bright) so a deep brand primary (e.g. sienna #9c5b1f)
  // still produces vivid dots against the dark hero gradient.
  function parseHex(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    if (m) {
      var n = parseInt(m[1], 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    var rm = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(hex);
    if (rm) return [parseInt(rm[1], 10), parseInt(rm[2], 10), parseInt(rm[3], 10)];
    return null;
  }
  function mixToward(hex, target, w) {
    var a = parseHex(hex) || [124, 58, 237];
    var b = parseHex(target) || [255, 255, 255];
    var r = Math.round(a[0] * (1 - w) + b[0] * w);
    var g = Math.round(a[1] * (1 - w) + b[1] * w);
    var bl = Math.round(a[2] * (1 - w) + b[2] * w);
    return r + ',' + g + ',' + bl;
  }
  function readPalette() {
    var s = getComputedStyle(document.documentElement);
    var primary = s.getPropertyValue('--bd-primary').trim() || '#2563EB';
    var accent = s.getPropertyValue('--bd-primary-500').trim() || primary;
    return { primary: primary, accent: accent };
  }
  function hexToRgbTriple(hex) {
    var rgb = parseHex(hex);
    return rgb ? rgb.join(',') : '124,58,237';
  }

  function init() {
    var canvas = document.getElementById('bd-hero-canvas');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    if (!ctx) return;

    var palette = readPalette();
    // Mix toward white to brighten the particles against the dark
    // hero gradient — matches the aggregator web BrandPanel exactly.
    var primaryRgb = mixToward(palette.primary, '#FFFFFF', 0.5);
    var brightRgb = mixToward(palette.accent, '#FFFFFF', 0.4);
    var lineRgb = mixToward(palette.accent, '#FFFFFF', 0.6);

    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var dots = [];
    var raf = 0;

    function rect() {
      return canvas.getBoundingClientRect();
    }

    function resize() {
      var r = rect();
      canvas.width = r.width * dpr;
      canvas.height = r.height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function buildDots() {
      var r = rect();
      var W = r.width;
      var H = r.height;
      if (W < 10 || H < 10) return;
      var COUNT = Math.max(55, Math.min(85, Math.round((W * H) / 18000)));
      var aspect = W / H;
      var COLS = Math.max(6, Math.round(Math.sqrt(COUNT * aspect)));
      var ROWS = Math.ceil(COUNT / COLS);
      var cellW = W / COLS;
      var cellH = H / ROWS;
      var next = [];
      for (var row = 0; row < ROWS; row++) {
        for (var col = 0; col < COLS; col++) {
          if (next.length >= COUNT) break;
          var cx = cellW * (col + 0.2 + Math.random() * 0.6);
          var cy = cellH * (row + 0.2 + Math.random() * 0.6);
          next.push({
            ax: cx,
            ay: cy,
            x: cx,
            y: cy,
            dPhaseX: Math.random() * Math.PI * 2,
            dPhaseY: Math.random() * Math.PI * 2,
            dSpeedX: 0.003 + Math.random() * 0.004,
            dSpeedY: 0.003 + Math.random() * 0.004,
            dAmpX: 6 + Math.random() * 10,
            dAmpY: 6 + Math.random() * 10,
            r: Math.random() * 1.6 + 1.6,
            pulse: Math.random() * Math.PI * 2,
            hue: Math.random() < 0.22 ? 'bright' : 'soft',
          });
        }
      }
      dots = next;
    }

    function onResize() {
      resize();
      buildDots();
    }

    function draw() {
      var r = rect();
      var w = r.width;
      var h = r.height;
      ctx.clearRect(0, 0, w, h);

      var LINK = 200;
      for (var i = 0; i < dots.length; i++) {
        for (var j = i + 1; j < dots.length; j++) {
          var a = dots[i];
          var b = dots[j];
          if (!a || !b) continue;
          var dx = a.x - b.x;
          var dy = a.y - b.y;
          var d = Math.sqrt(dx * dx + dy * dy);
          if (d < LINK) {
            var o = 1 - d / LINK;
            ctx.strokeStyle = 'rgba(' + lineRgb + ',' + o * 0.55 + ')';
            ctx.lineWidth = 0.9;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }

      for (var k = 0; k < dots.length; k++) {
        var dot = dots[k];
        dot.dPhaseX += dot.dSpeedX;
        dot.dPhaseY += dot.dSpeedY;
        dot.x = dot.ax + Math.sin(dot.dPhaseX) * dot.dAmpX;
        dot.y = dot.ay + Math.cos(dot.dPhaseY) * dot.dAmpY;

        dot.pulse += 0.02;
        var pulse = (Math.sin(dot.pulse) + 1) / 2;
        var rad = dot.r + pulse * 0.6;

        var isBright = dot.hue === 'bright';
        var coreRgb = isBright ? brightRgb : primaryRgb;
        var core = 'rgb(' + coreRgb + ')';
        var glow = 'rgba(' + coreRgb + ',';

        var grad = ctx.createRadialGradient(dot.x, dot.y, 0, dot.x, dot.y, rad * 6);
        grad.addColorStop(0, glow + (0.5 + pulse * 0.3) + ')');
        grad.addColorStop(1, glow + '0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(dot.x, dot.y, rad * 6, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = core;
        ctx.beginPath();
        ctx.arc(dot.x, dot.y, rad, 0, Math.PI * 2);
        ctx.fill();
      }

      raf = requestAnimationFrame(draw);
    }

    onResize();
    if (typeof ResizeObserver !== 'undefined') {
      var ro = new ResizeObserver(onResize);
      ro.observe(canvas);
    } else {
      window.addEventListener('resize', onResize);
    }
    draw();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
