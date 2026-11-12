// Searching the signs in the browser. The search box on /signs fetches `/signs.json` (the open
// data file, already public and cached) the first time someone types, and filters every sign
// there, so a search covers all of them however many cards the page has drawn. Nothing is sent
// to the server and no query parameter is used.
//
// The filter is browser JavaScript kept as source text, so any page can put it in its script:
// `SIGN_SEARCH_JS` defines `rsmSignMatches(sign, query)` for a sign as `/signs.json` writes it.
// Quiz can use it the same way. Tests run the same text (test/search.test.ts).

/**
 * `rsmSignMatches(sign, query)`: true when every word of the query is in the sign. A word is
 * found in its title, place, state, finders (name or handle) or ways, ignoring case and accents;
 * a number matches one of the sign's numbers, or stands on its own in the title or place ("35"
 * finds I-35W, never 335). An empty query matches nothing: the page shows its own lists then.
 *
 * Written without backticks or template holes, since it lives in a template string.
 */
export const SIGN_SEARCH_JS = String.raw`
function rsmFold(text) {
  return String(text == null ? '' : text).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}
function rsmQueryWords(query) {
  return rsmFold(query)
    .split(/[^\p{L}\p{N}.']+/u)
    .map(function (w) { return w.replace(/^[.']+|[.']+$/g, ''); })
    .filter(function (w) { return /[\p{L}\p{N}]/u.test(w); });
}
function rsmSignMatches(sign, query) {
  var words = rsmQueryWords(query);
  if (!words.length) return false;
  var place = sign.place || {};
  var named = rsmFold([sign.title, place.label].join(' '));
  var text = rsmFold(
    [sign.title, place.label, place.state]
      .concat((sign.finders || []).map(function (f) { return f.name + ' ' + (f.handle || ''); }))
      .concat((sign.ways || []).map(function (w) { return w.text; }))
      .join(' ')
  );
  var numbers = (sign.numbers || []).map(function (n) { return rsmFold(n.value); });
  return words.every(function (w) {
    if (/^\d+(\.\d+)?$/.test(w)) {
      if (numbers.indexOf(w) >= 0) return true;
      var at = named.indexOf(w);
      while (at >= 0) {
        var before = named.charAt(at - 1);
        var after = named.charAt(at + w.length);
        if (!/[\d.]/.test(before) && !/\d/.test(after)) return true;
        at = named.indexOf(w, at + 1);
      }
      return false;
    }
    return text.indexOf(w) >= 0;
  });
}
`;
