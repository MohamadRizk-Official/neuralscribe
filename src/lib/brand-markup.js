// The SparkScribe brand: ONE source for the mark and wordmark on every page. vite.config.js inserts it at
// build time wherever a page says <!-- sparkscribe:brand --> (header) or <!-- sparkscribe:mark --> (the mark
// alone, e.g. the upload icon), so no page carries its own copy.
//
// Mark: five audio bars; the center one is a lightning bolt. At rest each bar keeps its brand color
// (cyan, blue, [bolt: bright cyan → violet], purple, pink). The motion (style.css) is center-out: the bolt
// lights first, then the inner bars, then the outer bars, each settling back to its color. The light comes
// from separate highlight shapes laid over each bar, so the energy visibly travels through the waveform.
//
// Wordmark: "Spark" in an angular face (Chakra Petch, loaded for those five letters only), cyan → blue;
// "Scribe" in the site's clean sans (Space Grotesk), purple → pink.

const BOLT = 'M22.8 1.5 16 21.4h4l-2.8 17.1 6.8-20.9h-4.2z';
const shapes = (cls) => [
  `<rect class="${cls} o" x="2" y="14" width="4" height="12" rx="2"/>`,
  `<rect class="${cls} i" x="9" y="9" width="4" height="22" rx="2"/>`,
  `<path class="${cls} c" d="${BOLT}"/>`,
  `<rect class="${cls} i" x="27" y="10" width="4" height="20" rx="2"/>`,
  `<rect class="${cls} o" x="34" y="15" width="4" height="10" rx="2"/>`,
].join('');

const DEFS = '<defs>'
  + '<linearGradient id="sparkBars" gradientUnits="userSpaceOnUse" x1="2" y1="0" x2="38" y2="0">'
  + '<stop offset="0" stop-color="#22d3ee"/><stop offset=".3" stop-color="#3b82f6"/><stop offset=".68" stop-color="#a78bfa"/><stop offset="1" stop-color="#f472b6"/>'
  + '</linearGradient>'
  + '<linearGradient id="sparkBolt" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#a5f3fc"/><stop offset="1" stop-color="#a78bfa"/></linearGradient>'
  + '</defs>';

// the mark; `defs` only once per page (the header's), other copies reuse its gradients
export const markSvg = ({ cls = '', defs = false } = {}) =>
  `<svg class="spark-mark${cls ? ` ${cls}` : ''}" viewBox="0 0 40 40" aria-hidden="true" focusable="false">${defs ? DEFS : ''}`
  + `<g class="sm-base">${shapes('sm')}</g><g class="sm-light">${shapes('sl')}</g></svg>`;

export const BRAND_HTML = '<a class="brand" href="/" aria-label="SparkScribe home">'
  + markSvg({ cls: 'brand-mark', defs: true })
  + '<span class="brand-name"><span class="bn-spark">Spark</span><span class="bn-scribe">Scribe</span></span></a>';

export const MARK_HTML = markSvg();

export const BRAND_FONT_LINK = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@600&amp;text=Spark&amp;display=swap" />';
