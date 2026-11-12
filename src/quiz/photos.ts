// A sign's photos, enlarged. Each photo on a Quiz page is a link to its large copy, so without
// scripts a tap opens the photo itself. With this script the tap opens it over the page in a
// <dialog> instead: the whole photo, as big as the screen allows. Escape closes it (the dialog's
// own), and so does the close button, a tap on the photo or a tap outside it; focus goes back to
// the photo that opened it. No dependency.

export const PHOTOS_JS = `(() => {
  const box = document.getElementById('zoom');
  if (!box || typeof box.showModal !== 'function') return;
  const big = box.querySelector('img');
  let from = null;
  document.querySelectorAll('[data-zoom]').forEach((link) =>
    link.addEventListener('click', (e) => {
      e.preventDefault();
      from = link;
      const shown = link.querySelector('img');
      big.src = link.href;
      big.alt = shown ? shown.alt : '';
      box.showModal();
    })
  );
  box.addEventListener('click', (e) => {
    if (e.target === box || e.target === big) box.close();
  });
  box.addEventListener('close', () => {
    big.removeAttribute('src');
    if (from) from.focus();
  });
})();`;
