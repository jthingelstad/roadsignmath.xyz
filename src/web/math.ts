// Draws a way's math as SVG on the server with MathJax, so pages show stacked fractions and
// real roots without any script in the browser. The app draws the same LaTeX with SwiftMath.

import { mathjax } from 'mathjax-full/js/mathjax.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { SVG } from 'mathjax-full/js/output/svg.js';
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const doc = mathjax.document('', {
  InputJax: new TeX({ packages: ['base'] }),
  OutputJax: new SVG({ fontCache: 'local' })
});

const drawn = new Map<string, string>();

/** The SVG markup for one line of LaTeX in the text colour. Display style, so a fraction is
 * full size even inline; screen readers get the text from the wrapper, not the drawing. */
export function mathSvg(tex: string): string {
  let svg = drawn.get(tex);
  if (svg === undefined) {
    svg = adaptor.innerHTML(doc.convert(tex, { display: true })).replace('<svg ', '<svg aria-hidden="true" ');
    if (drawn.size >= 1000) drawn.clear();
    drawn.set(tex, svg);
  }
  return svg;
}
