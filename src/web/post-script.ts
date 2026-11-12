// The posting form's scripts (src/web/post.tsx). The form works without them: one photo at a time
// sent as it is (a JPEG, PNG or WebP of at most 4 MB), the numbers and the place typed, the math
// typed into a text field the server checks. With them:
//
// - A photo is read in the browser before it is sent: its place (GPS) and the day it was taken
//   from its EXIF, before anything else touches it, then it is turned upright, made at most 2048
//   pixels on its longest side and saved again as a JPEG under 4 MB, which leaves its metadata
//   behind. Up to four go at once, each sent as soon as it is ready. A photo the browser can't open
//   (HEIC outside Safari) is sent as it is when it is a kind the server takes, else refused here.
// - A tap on the first photo marks where a number is (its `box`).
// - The place can be picked on a map (Leaflet and OpenStreetMap's tiles, as on Home), never from
//   the browser's own location.
// - The form is kept in this browser (localStorage) until the sign posts, so a closed tab or a
//   lost connection loses nothing.
// - On the math step, Quiz's keypad (src/quiz/keypad.ts) builds the math from the tiles.

import { MAP_LIBRARIES, MAP_TILES, US_VIEW } from './home-map.ts';

/** Where the draft is kept in the browser until the sign posts. */
export const DRAFT_KEY = 'rsm-post-draft';

/**
 * Reads a photo's EXIF for its place and day: `window.RSMExif.read(bytes)` gives `{ lat, lng, day }`,
 * each only when the photo carries it. It looks for the EXIF block wherever it is ("Exif\0\0" then
 * a TIFF header), so it reads JPEGs and the HEIC photos Safari hands over alike.
 */
export const EXIF_JS = `(() => {
  const tiff = (b, t) => {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const le = b[t] === 0x49 && b[t + 1] === 0x49;
    if (!le && !(b[t] === 0x4d && b[t + 1] === 0x4d)) return undefined;
    const u16 = (o) => v.getUint16(t + o, le);
    const u32 = (o) => v.getUint32(t + o, le);
    if (u16(2) !== 42) return undefined;
    const ifd = (o) => {
      const n = u16(o);
      const out = {};
      for (let k = 0; k < n; k++) {
        const e = o + 2 + k * 12;
        out[u16(e)] = { count: u32(e + 4), at: e + 8 };
      }
      return out;
    };
    const where = (e, size) => (e.count * size > 4 ? u32(e.at) : e.at);
    const rationals = (e) => {
      const o = where(e, 8);
      const r = [];
      for (let k = 0; k < e.count; k++) r.push(u32(o + k * 8) / u32(o + k * 8 + 4));
      return r;
    };
    const ascii = (e) => {
      const o = where(e, 1);
      let s = '';
      for (let k = 0; k < e.count; k++) {
        const c = b[t + o + k];
        if (!c) break;
        s += String.fromCharCode(c);
      }
      return s;
    };
    const out = {};
    const zero = ifd(u32(4));
    if (zero[0x8825]) {
      const g = ifd(u32(zero[0x8825].at));
      if (g[2] && g[4]) {
        const deg = (e) => {
          const r = rationals(e);
          return r[0] + (r[1] || 0) / 60 + (r[2] || 0) / 3600;
        };
        let lat = deg(g[2]);
        let lng = deg(g[4]);
        if (g[1] && ascii(g[1]) === 'S') lat = -lat;
        if (g[3] && ascii(g[3]) === 'W') lng = -lng;
        if (isFinite(lat) && isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (lat || lng)) {
          out.lat = Math.round(lat * 1e5) / 1e5;
          out.lng = Math.round(lng * 1e5) / 1e5;
        }
      }
    }
    if (zero[0x8769]) {
      const x = ifd(u32(zero[0x8769].at));
      const d = x[0x9003] || x[0x9004];
      const m = d && /^(\\d{4}):(\\d{2}):(\\d{2})/.exec(ascii(d));
      if (m) out.day = m[1] + '-' + m[2] + '-' + m[3];
    }
    return out;
  };
  const read = (buffer) => {
    const b = new Uint8Array(buffer);
    for (let i = 0; i + 14 < b.length; i++) {
      if (b[i] === 0x45 && b[i + 1] === 0x78 && b[i + 2] === 0x69 && b[i + 3] === 0x66 && b[i + 4] === 0 && b[i + 5] === 0) {
        try {
          const found = tiff(b, i + 6);
          if (found) return found;
        } catch (e) {
          // a broken block: look on
        }
      }
    }
    return {};
  };
  window.RSMExif = { read };
})();`;

/** The details step: photos, the numbers and their places on the photo, the map pick, the draft. */
export const POST_JS = `(() => {
  const form = document.getElementById('post-form');
  if (!form) return;
  const MAX = ${4 * 1024 * 1024};
  const MOST = Number(form.dataset.most) || 4;
  const shots = document.getElementById('shots');
  const file = document.getElementById('photo-file');
  const add = document.getElementById('photo-add');
  const said = document.getElementById('photo-said');
  const lat = form.elements.namedItem('lat');
  const lng = form.elements.namedItem('lng');
  const day = form.elements.namedItem('found_on');
  const approx = form.elements.namedItem('approximate');
  const store = (() => { try { return window.localStorage; } catch (e) { return undefined; } })();
  const say = (words) => { said.textContent = words; };
  const ids = () => Array.from(shots.querySelectorAll('input[name="photos"]')).map((i) => i.value);
  const room = () => {
    const full = ids().length >= MOST;
    document.getElementById('photo-pick').hidden = full;
    marker();
  };

  // ---- The draft, kept in this browser until the sign posts
  const save = () => {
    if (!store) return;
    const data = { photos: ids() };
    for (const el of Array.from(form.elements)) {
      if (!el.name || el.tagName === 'BUTTON' || el.type === 'file' || el.name === 'photos') continue;
      data[el.name] = el.type === 'checkbox' ? (el.checked ? '1' : '') : el.value;
    }
    try { store.setItem('${DRAFT_KEY}', JSON.stringify(data)); } catch (e) { /* full or blocked: the form still works */ }
  };
  let timer;
  const later = () => { clearTimeout(timer); timer = setTimeout(save, 300); };
  form.addEventListener('input', later);
  form.addEventListener('change', later);

  // ---- Photos
  const shot = (id) => {
    const li = document.createElement('li');
    const img = document.createElement('img');
    img.src = '/post/photos/' + id + '/thumb.jpg';
    img.alt = 'Photo ' + (ids().length + 1);
    img.addEventListener('error', () => { li.remove(); room(); save(); });
    const keep = document.createElement('input');
    keep.type = 'hidden';
    keep.name = 'photos';
    keep.value = id;
    const drop = document.createElement('button');
    drop.type = 'submit';
    drop.name = 'go';
    drop.value = 'drop:' + id;
    drop.className = 'txt bad';
    drop.textContent = 'Remove';
    li.append(img, keep, drop);
    shots.append(li);
    room();
  };
  shots.addEventListener('click', (e) => {
    const drop = e.target.closest && e.target.closest('button[value^="drop:"]');
    if (!drop) return;
    e.preventDefault();
    drop.closest('li').remove();
    room();
    save();
    say('Photo removed.');
  });
  const decode = async (blob) => {
    try {
      return await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch (e) {
      const url = URL.createObjectURL(blob);
      try {
        return await new Promise((ok, no) => {
          const img = new Image();
          img.onload = () => ok(img);
          img.onerror = no;
          img.src = url;
        });
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    }
  };
  const shrink = async (picture) => {
    const w0 = picture.width || picture.naturalWidth;
    const h0 = picture.height || picture.naturalHeight;
    const canvas = document.createElement('canvas');
    for (const [edge, q] of [[2048, 0.86], [1600, 0.8], [1280, 0.72]]) {
      const s = Math.min(1, edge / Math.max(w0, h0));
      canvas.width = Math.max(1, Math.round(w0 * s));
      canvas.height = Math.max(1, Math.round(h0 * s));
      canvas.getContext('2d').drawImage(picture, 0, 0, canvas.width, canvas.height);
      const out = await new Promise((done) => canvas.toBlob(done, 'image/jpeg', q));
      if (out && out.size <= MAX) return out;
    }
    return undefined;
  };
  const TAKEN = ['image/jpeg', 'image/png', 'image/webp'];
  const send = async (blob, name) => {
    const body = new FormData();
    body.append('go', 'photo');
    body.append('photo', blob, name);
    const res = await fetch('/post', { method: 'POST', body, headers: { Accept: 'application/json' }, credentials: 'same-origin' });
    const answer = await res.json().catch(() => ({}));
    if (!res.ok || !answer.id) throw new Error((answer.error && answer.error.message) || 'That photo didn’t go up. Try again.');
    return answer.id;
  };
  const one = async (picked, n, of) => {
    const label = of > 1 ? 'Photo ' + n + ' of ' + of + ': ' : '';
    say(label + 'Getting it ready…');
    const bytes = await picked.arrayBuffer();
    const found = window.RSMExif ? window.RSMExif.read(bytes) : {};
    let blob;
    const picture = await decode(picked).catch(() => undefined);
    if (picture) blob = await shrink(picture);
    else if (TAKEN.includes(picked.type) && picked.size <= MAX) blob = picked;
    if (!blob) {
      say(label + (picture ? 'That photo is too big even made smaller.' : 'This browser can’t open that photo. Choose a JPEG or PNG, or save it as one first.'));
      return;
    }
    say(label + 'Sending it…');
    const id = await send(blob, 'photo.jpg');
    shot(id);
    const words = [label + 'Added.'];
    if (found.lat !== undefined && !lat.value && !lng.value) {
      lat.value = found.lat;
      lng.value = found.lng;
      if (approx) approx.checked = false;
      pin();
      words.push('Its place is from the photo.');
    }
    if (found.day && day && day.dataset.auto === '1' && found.day <= day.max) {
      day.value = found.day;
      day.dataset.auto = '0';
      words.push('So is the day.');
    }
    say(words.join(' '));
    save();
  };
  if (file) {
    file.multiple = true;
    if (add) add.hidden = true;
    file.addEventListener('change', async () => {
      const picked = Array.from(file.files || []).slice(0, Math.max(0, MOST - ids().length));
      file.value = '';
      for (let i = 0; i < picked.length; i++) {
        try {
          await one(picked[i], i + 1, picked.length);
        } catch (e) {
          say(e.message);
        }
      }
    });
  }
  if (day) day.addEventListener('input', () => { day.dataset.auto = '0'; });

  // ---- More rows of numbers and of people, one at a time
  const rows = Array.from(form.querySelectorAll('.num'));
  const showRows = (kind, n) => {
    const all = Array.from(form.querySelectorAll('.' + kind));
    const btn = form.querySelector('[data-more="' + kind + '"]');
    all.forEach((row, i) => { row.hidden = i >= n; });
    form.elements.namedItem(btn ? btn.dataset.count : kind === 'num' ? 'rows' : 'people').value = String(n);
    if (btn) btn.hidden = n >= all.length;
  };
  form.querySelectorAll('[data-more]').forEach((btn) => {
    btn.type = 'button';
    btn.addEventListener('click', () => {
      const kind = btn.dataset.more;
      const all = Array.from(form.querySelectorAll('.' + kind));
      const n = Math.min(all.length, Number(form.elements.namedItem(btn.dataset.count).value) + 1);
      showRows(kind, n);
      all[n - 1].querySelector('input').focus();
      save();
    });
  });
  const mark = document.getElementById('mark');
  const markImg = mark && mark.querySelector('img');
  let marking = -1;
  const boxOf = (row) => {
    const v = row.querySelector('input[name$="_box"]').value.split(',').map(Number);
    return v.length === 4 && v.every(isFinite) ? v : undefined;
  };
  function marker() {
    if (!mark) return;
    const first = ids()[0];
    mark.hidden = !first;
    form.querySelectorAll('.mark-btn').forEach((b) => { b.hidden = !first; });
    if (!first) return;
    const src = '/post/photos/' + first + '/thumb.jpg';
    if (markImg.getAttribute('src') !== src) markImg.src = src;
    mark.querySelectorAll('.box').forEach((b) => b.remove());
    rows.forEach((row, i) => {
      const box = boxOf(row);
      if (!box || row.hidden) return;
      const el = document.createElement('span');
      el.className = 'box' + (i === marking ? ' on' : '');
      el.style.left = box[0] * 100 + '%';
      el.style.top = box[1] * 100 + '%';
      el.style.width = box[2] * 100 + '%';
      el.style.height = box[3] * 100 + '%';
      el.textContent = String(i + 1);
      mark.append(el);
    });
  }
  const markSaid = document.getElementById('mark-said');
  form.querySelectorAll('.mark-btn').forEach((btn) => {
    btn.type = 'button';
    btn.addEventListener('click', () => {
      marking = Number(btn.dataset.row);
      markSaid.textContent = 'Tap the photo where number ' + (marking + 1) + ' is.';
      mark.scrollIntoView({ block: 'nearest' });
      marker();
    });
  });
  if (mark) {
    markImg.addEventListener('click', (e) => {
      if (marking < 0) return;
      const r = markImg.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      const y = (e.clientY - r.top) / r.height;
      const w = 0.12;
      const h = 0.08;
      const left = Math.min(1 - w, Math.max(0, x - w / 2));
      const top = Math.min(1 - h, Math.max(0, y - h / 2));
      const row = rows[marking];
      row.querySelector('input[name$="_box"]').value = [left, top, w, h].map((v) => v.toFixed(4)).join(',');
      markSaid.textContent = 'Number ' + (marking + 1) + ' is marked.';
      marking = -1;
      marker();
      save();
    });
  }

  // ---- The place: a pin from the photo, typed, or picked on the map
  let map;
  let dot;
  function pin() {
    if (!map) return;
    const a = Number(lat.value);
    const b = Number(lng.value);
    if (lat.value && lng.value && isFinite(a) && isFinite(b)) {
      if (dot) dot.setLatLng([a, b]);
      else dot = window.L.marker([a, b]).addTo(map);
      map.setView([a, b], Math.max(map.getZoom(), 12));
    }
  }
  const load = (tag, attrs) =>
    new Promise((ok, no) => {
      const el = document.createElement(tag);
      Object.assign(el, attrs);
      el.crossOrigin = 'anonymous';
      el.onload = ok;
      el.onerror = no;
      document.head.append(el);
    });
  const open = document.getElementById('map-open');
  const centre = document.getElementById('map-centre');
  const box = document.getElementById('pick-map');
  if (open && box) {
    open.hidden = false;
    open.addEventListener('click', async () => {
      open.disabled = true;
      try {
        if (!window.L) {
          ${JSON.stringify(MAP_LIBRARIES.css)}.forEach((c) => load('link', { rel: 'stylesheet', href: c.href, integrity: c.integrity }));
          await load('script', { src: ${JSON.stringify(MAP_LIBRARIES.js[0].src)}, integrity: ${JSON.stringify(MAP_LIBRARIES.js[0].integrity)} });
        }
        box.hidden = false;
        open.hidden = true;
        centre.hidden = false;
        map = window.L.map(box, { scrollWheelZoom: false });
        window.L.tileLayer(${JSON.stringify(MAP_TILES.url)}, { maxZoom: 19, attribution: ${JSON.stringify(MAP_TILES.attribution)} }).addTo(map);
        map.fitBounds(${JSON.stringify(US_VIEW)});
        map.on('click', (e) => {
          lat.value = e.latlng.lat.toFixed(5);
          lng.value = e.latlng.lng.toFixed(5);
          pin();
          save();
        });
        pin();
      } catch (e) {
        open.disabled = false;
        document.getElementById('map-said').textContent = 'The map didn’t load. Type the place, and the latitude and longitude if you know them.';
      }
    });
    centre.addEventListener('click', () => {
      if (!map) return;
      const c = map.getCenter();
      lat.value = c.lat.toFixed(5);
      lng.value = c.lng.toFixed(5);
      pin();
      save();
    });
    [lat, lng].forEach((el) => el.addEventListener('change', pin));
  }

  // ---- A draft from before, back in a fresh form
  const fresh = form.dataset.fresh === '1';
  let kept;
  try { kept = fresh && store ? JSON.parse(store.getItem('${DRAFT_KEY}') || 'null') : undefined; } catch (e) { kept = undefined; }
  if (kept && typeof kept === 'object') {
    for (const [name, value] of Object.entries(kept)) {
      const el = form.elements.namedItem(name);
      if (!el || typeof value !== 'string' || el.type === 'file' || el.length) continue;
      if (el.type === 'checkbox') el.checked = value === '1';
      else el.value = value;
    }
    if (day && kept.found_on) day.dataset.auto = '0';
    (Array.isArray(kept.photos) ? kept.photos : [])
      .filter((id) => /^[0-9a-z]{26}$/.test(id))
      .slice(0, MOST)
      .forEach(shot);
    for (const [kind, count] of [['num', 'rows'], ['who', 'people']]) {
      const all = Array.from(form.querySelectorAll('.' + kind));
      const filled = all.reduce((n, row, i) => (row.querySelector('input').value ? i + 1 : n), 0);
      showRows(kind, Math.min(all.length, Math.max(Number(form.elements.namedItem(count).value) || 0, filled)));
    }
    if (ids().length || kept.title) say('Your draft from before is back.');
  }
  room();
})();`;

/** The posted page's: the draft is done with. */
export const DONE_JS = `try { window.localStorage.removeItem('${DRAFT_KEY}'); } catch (e) { /* nothing kept */ }`;
