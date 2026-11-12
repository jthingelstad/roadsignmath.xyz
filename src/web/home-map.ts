// Home's map, made one you can move: once the page has loaded, the picture of the United States
// with its pins becomes a Leaflet map of the world, with OpenStreetMap's tiles
// and every sign from /signs.geojson. Nearby signs gather into a numbered circle that opens as
// you zoom in, and a sign's dot opens a card that links to its page. The year chips filter the
// dots in place, and the list of signs off the map with them. Without the script, or if Leaflet,
// the tiles or the signs can't load, the picture and its pins stay: they are the page as the
// server draws it. The map stays hidden over the picture until its first tile has drawn.
//
// Leaflet and its clustering plugin come from cdnjs at fixed versions, each checked by its
// subresource integrity hash, and load only after the page is up.

const CDN = 'https://cdnjs.cloudflare.com/ajax/libs';

/** What the map loads, with the hash each file must match. */
export const MAP_LIBRARIES = {
  css: [
    {
      href: `${CDN}/leaflet/1.9.4/leaflet.min.css`,
      integrity: 'sha384-c6Rcwz4e4CITMbu/NBmnNS8yN2sC3cUElMEMfP3vqqKFp7GOYaaBBCqmaWBjmkjb'
    }
  ],
  js: [
    {
      src: `${CDN}/leaflet/1.9.4/leaflet.min.js`,
      integrity: 'sha384-NElt3Op+9NBMCYaef5HxeJmU4Xeard/Lku8ek6hoPTvYkQPh3zLIrJP7KiRocsxO'
    },
    {
      src: `${CDN}/leaflet.markercluster/1.5.3/leaflet.markercluster.min.js`,
      integrity: 'sha384-SIh+qcEBNMda8tT+rx66aCBuWtVYMVzRABqhK4eeQh4pjDHoRdVx8nYU4LQ5eGzI'
    }
  ]
} as const;

/**
 * OpenStreetMap's own tiles, under its tile usage policy (attribution shown, the browser's normal
 * referrer, no key). On dark, the page's style turns them dark (`.lmap .leaflet-tile-pane`).
 */
export const MAP_TILES = {
  url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
} as const;

/** Where the map opens: the lower 48, where most signs are. "World" shows every sign. */
export const US_VIEW: [[number, number], [number, number]] = [
  [24.5, -124.8],
  [49.4, -66.9]
];

export const HOME_MAP_STYLE = `
.map .lmap { position: absolute; inset: 0; z-index: 0; background: var(--ground); font: inherit; }
.lmap .leaflet-control-attribution { font-size: 11px; }
.lmap .leaflet-popup-content-wrapper { border-radius: 12px; }
.lmap .leaflet-popup-content { margin: 12px 14px; font-size: 14px; line-height: 1.35; }
.lmap .leaflet-popup-content a.sign { display: flex; gap: 10px; align-items: center; color: var(--ink); text-decoration: none; }
.lmap .leaflet-popup-content img { width: 64px; height: 64px; border-radius: 8px; object-fit: cover; flex: 0 0 auto; background: var(--photo); }
.lmap .leaflet-popup-content strong { display: block; font-size: 15px; text-decoration: underline; text-decoration-color: var(--line2); }
.lmap .leaflet-popup-content .math { display: block; color: var(--green-ink); font-weight: 700; }
.lmap .leaflet-popup-content .soft { display: block; color: var(--soft); font-size: 13px; }
#map-panel .picked[hidden] { display: none; }
.map .lmap.waiting { visibility: hidden; }
@media (prefers-color-scheme: dark) {
  .lmap .leaflet-tile-pane { filter: invert(1) hue-rotate(180deg) brightness(.9) contrast(.9); }
  .lmap .leaflet-popup-content-wrapper, .lmap .leaflet-popup-tip { background: var(--card); color: var(--ink); }
  .lmap .leaflet-bar a { background: var(--card); color: var(--ink); border-color: var(--line); }
  .map .lmap .leaflet-control-attribution { background: rgba(24,32,28,.8); color: var(--ink2); }
  .map .lmap .leaflet-control-attribution a { color: var(--ink); }
}
.lmap .dot, .lmap .bunch { display: flex; align-items: center; justify-content: center; border-radius: 50%; border: 3px solid #fff;
  background: var(--green); color: #fff; font-weight: 900; line-height: 1; box-shadow: 0 1px 4px rgba(0,0,0,.45); cursor: pointer; }
.lmap .dot:hover, .lmap .bunch:hover { background: var(--green-dark); }
.lmap .bunch { font-size: 13px; }
.lmap .views { display: flex; }
.lmap .views button { font: inherit; font-size: 13px; font-weight: 800; min-height: 32px; padding: 0 12px; border: 0; background: var(--card);
  color: var(--ink); cursor: pointer; }
.lmap .views button + button { border-left: 1px solid var(--line); }
.lmap .views button[aria-pressed="true"] { background: var(--chip-on); color: var(--chip-on-ink); }
`;

/**
 * The script: loads Leaflet, swaps the picture for the map, and takes over the year chips.
 * It sets `data-live` on the map panel once the map is up, which the panel-swapping script
 * reads to leave the chips to it.
 */
export const HOME_MAP_SCRIPT = `
(() => {
  if (!document.querySelector('#map-panel .map') || !window.fetch || !window.Promise) return;
  const LIB = ${JSON.stringify(MAP_LIBRARIES)};
  const TILES = ${JSON.stringify(MAP_TILES)};
  const US = ${JSON.stringify(US_VIEW)};
  const add = (tag, attrs) => new Promise((ok, fail) => {
    const el = document.createElement(tag);
    Object.assign(el, attrs, { crossOrigin: 'anonymous', onload: ok, onerror: fail });
    document.head.appendChild(el);
  });
  const text = (tag, cls, words) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    el.textContent = words;
    return el;
  };
  const card = (p) => {
    const a = document.createElement('a');
    a.className = 'sign';
    a.href = '/signs/' + encodeURIComponent(p.slug);
    if (p.thumb_url) {
      const img = document.createElement('img');
      img.src = p.thumb_url;
      img.alt = '';
      a.appendChild(img);
    }
    const words = document.createElement('span');
    words.appendChild(text('strong', '', p.title));
    if (p.math) words.appendChild(text('span', 'math', p.math));
    words.appendChild(text('span', 'soft', [p.finders, p.place].filter(Boolean).join(' · ')));
    a.appendChild(words);
    return a;
  };
  (async () => {
    let map, holder;
    try {
      const signs = fetch('/signs.geojson').then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); });
      await Promise.all(LIB.css.map((c) => add('link', { rel: 'stylesheet', href: c.href, integrity: c.integrity })));
      for (const s of LIB.js) await add('script', { src: s.src, integrity: s.integrity });
      const features = (await signs).features.filter((f) => f.geometry);
      const L = window.L;
      // Found again now: a pin or chip tapped while Leaflet loaded may have swapped the panel.
      const box = document.querySelector('#map-panel .map');
      if (!box) return;
      holder = document.createElement('div');
      holder.className = 'lmap waiting';
      box.appendChild(holder);
      map = L.map(holder, { scrollWheelZoom: false, worldCopyJump: true, zoomSnap: 0.5, minZoom: 1 });
      const tiles = L.tileLayer(TILES.url, { attribution: TILES.attribution, maxZoom: 19 }).addTo(map);
      // The picture stays until a tile has drawn: with none in ten seconds, or every one failing, it stays for good.
      const drawn = new Promise((ok, fail) => {
        let any = false;
        tiles.once('tileload', () => { any = true; ok(); });
        tiles.once('load', () => (any ? ok() : fail(new Error('no tiles'))));
        setTimeout(() => fail(new Error('tiles timed out')), 10000);
      });
      drawn.catch(() => {}); // awaited below; this only keeps an early failure from going unhandled
      map.fitBounds(US);
      // Scroll the page, not the map, until the reader reaches for the map.
      map.once('focus click', () => map.scrollWheelZoom.enable());
      const group = L.markerClusterGroup({
        showCoverageOnHover: false,
        maxClusterRadius: 44,
        spiderfyDistanceMultiplier: 1.6,
        iconCreateFunction: (c) => {
          const n = c.getChildCount();
          const size = n < 10 ? 32 : n < 50 ? 38 : 44;
          return L.divIcon({ html: String(n), className: 'bunch', iconSize: [size, size] });
        }
      });
      const markers = features.map((f) => {
        const [lng, lat] = f.geometry.coordinates;
        const m = L.marker([lat, lng], {
          icon: L.divIcon({ className: 'dot', iconSize: [20, 20] }),
          title: f.properties.title,
          alt: f.properties.title,
          keyboard: true
        });
        m.bindPopup(() => card(f.properties), { minWidth: 220, maxWidth: 300 });
        m.year = String(f.properties.found_on).slice(0, 4);
        return m;
      });
      let nopin = null;
      const show = (year) => {
        group.clearLayers();
        group.addLayers(year ? markers.filter((m) => m.year === year) : markers);
        // Signs off the map follow the year too.
        if (!nopin) return;
        let any = false;
        nopin.querySelectorAll('.np').forEach((el) => {
          el.hidden = Boolean(year) && el.dataset.year !== year;
          any = any || !el.hidden;
        });
        nopin.hidden = !any;
      };
      show(new URLSearchParams(location.search).get('year'));
      map.addLayer(group);
      // US or the whole world.
      const Views = L.Control.extend({
        onAdd: () => {
          const bar = L.DomUtil.create('div', 'leaflet-bar views');
          const pick = (label, go) => {
            const b = L.DomUtil.create('button', '', bar);
            b.type = 'button';
            b.textContent = label;
            b.setAttribute('aria-pressed', String(label === 'US'));
            L.DomEvent.on(b, 'click', (e) => {
              L.DomEvent.stop(e);
              go();
              bar.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
            });
          };
          pick('US', () => map.fitBounds(US));
          pick('World', () => {
            const bounds = group.getBounds();
            if (bounds.isValid()) map.fitBounds(bounds, { padding: [24, 24] });
            else map.setView([20, 0], 1);
          });
          L.DomEvent.disableClickPropagation(bar);
          return bar;
        }
      });
      new Views({ position: 'topright' }).addTo(map);
      await drawn;
      // If the panel was swapped while the tiles loaded, the map is in the old one: leave the new one as it is.
      if (!holder.isConnected) throw new Error('panel replaced');
      holder.classList.remove('waiting');
      map.invalidateSize();
      // The picture and its pins go; so does the panel that listed a pin's signs, which the cards replace.
      for (const el of box.querySelectorAll(':scope > img, :scope > .pin')) el.remove();
      const panel = document.getElementById('map-panel');
      const picked = panel.querySelector('.picked');
      if (picked) picked.hidden = true;
      // Signs the picture couldn't place but the map can.
      nopin = panel.querySelector('.nopin');
      if (nopin) {
        nopin.querySelectorAll('[data-onmap]').forEach((el) => el.remove());
        if (!nopin.querySelector('.np')) nopin.remove();
        nopin = nopin.isConnected ? nopin : null;
      }
      show(new URLSearchParams(location.search).get('year'));
      panel.dataset.live = '';
      panel.addEventListener('click', (e) => {
        const chip = e.target.closest && e.target.closest('.years a');
        if (!chip || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        show(new URL(chip.href).searchParams.get('year'));
        panel.querySelectorAll('.years a').forEach((a) => a.toggleAttribute('aria-current', a === chip));
        chip.setAttribute('aria-current', 'true');
        history.replaceState(null, '', chip.href);
      });
    } catch (err) {
      if (map) map.remove();
      if (holder) holder.remove();
    }
  })();
})();`;
