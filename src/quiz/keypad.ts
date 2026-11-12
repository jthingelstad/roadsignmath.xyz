// The solve page's keypad, as a browser script. The page works without it: the form has a text
// field for the math, which the server checks. With it the field goes, and the math is built
// from the sign's number tiles and the operator keys (no digits: numbers come only from the
// sign), checked on every tap by the bundled checker (window.RSMCheck, src/quiz/checker.ts) with
// the server's own rules, and against the sign's numbers as the server checks a way. Send stays
// off until the math works. On a keyboard the operators,
// Backspace and Enter work too; digits don't. The math a send came back with (a reordered way, a
// way already yours, math that didn't check) is put back on the keypad, and what the send said is
// read out by the status line, the page's one live region (the form's `data-said`).

export const KEYPAD_JS = `(() => {
  const form = document.getElementById('solve');
  const check = window.RSMCheck && window.RSMCheck.check;
  if (!form || !check) return;
  const field = form.querySelector('input[name="text"]');
  const pad = document.getElementById('pad');
  const plate = document.getElementById('math');
  const status = document.getElementById('status');
  const send = document.getElementById('send');
  const tiles = Array.from(pad.querySelectorAll('[data-v]'));
  document.getElementById('typed').hidden = true;
  pad.hidden = false;
  field.required = false;
  let tokens = [];
  let works = false;
  const SPACED = new Set(['+', '−', '×', '÷', '=']);
  const math = () => tokens.map((t) => (t.n !== undefined ? tiles[t.n].dataset.v : SPACED.has(t.op) ? ' ' + t.op + ' ' : t.op)).join('').replace(/\\s+/g, ' ').trim();
  const say = (kind, words, aside) => {
    status.className = 'chk ' + kind;
    status.textContent = '';
    const main = document.createElement('span');
    main.className = 'said';
    main.textContent = words;
    status.append(main);
    if (aside) {
      const side = document.createElement('span');
      side.className = 'aside';
      side.textContent = aside;
      status.append(side);
    }
  };
  const update = () => {
    const text = math();
    field.value = text;
    plate.textContent = text;
    plate.classList.toggle('empty', !text);
    if (!text) plate.textContent = 'Tap a number to start';
    const used = tokens.filter((t) => t.n !== undefined).length;
    tiles.forEach((tile, i) => {
      const taken = tokens.some((t) => t.n === i);
      tile.classList.toggle('used', taken);
      tile.setAttribute('aria-disabled', String(taken));
    });
    works = false;
    if (!text) say('wait', 'Tap the numbers and operators to build the math.');
    else {
      const r = check(text);
      const extra = r.ok ? window.RSMCheck.numbersNotOnSign(r.numbers, tiles.map((t) => t.dataset.v)) : [];
      const left = r.ok && !extra.length ? window.RSMCheck.numbersLeftOut(r.numbers, tiles.map((t) => t.dataset.v)) : [];
      if (r.ok && extra.length) say('wait', extra.join(', ') + (extra.length === 1 ? ' isn’t' : ' aren’t') + ' on the sign that often.');
      else if (r.ok && left.length) say('wait', 'It’s true. Now use every number: ' + left.join(', ') + (left.length === 1 ? ' is' : ' are') + ' left out.');
      else if (r.ok) {
        works = true;
        const all = used === tiles.length ? (tiles.length > 2 ? 'All ' + tiles.length + ' numbers used' : 'All numbers used') : '';
        say('ok', 'It works: both sides are ' + r.value + '.', all);
      } else if (r.error === 'parse') say('wait', 'Keep going.');
      else say('wait', r.message.replace(/([^.])$/, '$1.'));
    }
    send.disabled = !works;
  };
  const tap = (token) => {
    if (token.n !== undefined && tokens.some((t) => t.n === token.n)) return;
    // Two tiles side by side would run together as one number (1 and 2 as 12), which the sign
    // doesn't have: a number goes after an operator or a bracket, never straight after another.
    const last = tokens[tokens.length - 1];
    if (token.n !== undefined && last && last.n !== undefined) return;
    tokens.push(token);
    update();
  };
  const back = () => {
    tokens.pop();
    update();
  };
  tiles.forEach((tile, i) => tile.addEventListener('click', () => tap({ n: i })));
  pad.querySelectorAll('[data-k]').forEach((key) =>
    key.addEventListener('click', () => (key.dataset.k === 'del' ? back() : tap({ op: key.dataset.k })))
  );
  const KEYS = { '+': '+', '-': '−', '*': '×', x: '×', '/': '÷', '^': '^', '!': '!', '(': '(', ')': ')', '=': '=' };
  // The math sent last, back on the keypad as tiles and operators; left empty if it can't be.
  const restore = (text) => {
    const OPS = Object.assign({ '−': '−', '×': '×', '÷': '÷', '√': '√' }, KEYS);
    const out = [];
    let rest = text;
    while ((rest = rest.trimStart())) {
      const num = /^\\d+(?:\\.\\d+)?/.exec(rest);
      if (num) {
        const last = out[out.length - 1];
        const i = tiles.findIndex((tile, j) => tile.dataset.v === num[0] && !out.some((t) => t.n === j));
        if (i < 0 || (last && last.n !== undefined)) return [];
        out.push({ n: i });
        rest = rest.slice(num[0].length);
      } else if (OPS[rest[0]]) {
        out.push({ op: OPS[rest[0]] });
        rest = rest.slice(1);
      } else return [];
    }
    return out;
  };
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.querySelector && document.querySelector('dialog[open]')) return;
    const at = e.target;
    if (at && (at.tagName === 'INPUT' || at.tagName === 'TEXTAREA' || at.tagName === 'SELECT')) return;
    if (e.key === 'Backspace') { e.preventDefault(); back(); }
    else if (e.key === 'Enter') { if (works) form.requestSubmit(); }
    else if (KEYS[e.key]) { e.preventDefault(); tap({ op: KEYS[e.key] }); }
  });
  form.addEventListener('submit', (e) => {
    if (!works) { e.preventDefault(); return; }
    field.value = math();
    send.disabled = true;
  });
  if (field.value) tokens = restore(field.value);
  update();
  const said = form.dataset && form.dataset.said;
  if (said) setTimeout(() => say('wait', said), 150);
})();`;
