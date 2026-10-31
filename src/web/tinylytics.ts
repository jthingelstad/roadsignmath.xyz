// Tinylytics counts visits: the site's pages load its script, and the sign-in email carries its
// pixel. Neither sets cookies or keeps anything about a person; the pixel's path is the same for
// every email, so it counts emails opened, never who opened one. The site id is public: it is in
// every page.

export const TINYLYTICS_SITE = 'ryhTaXDDgZtyCktoVzzj';

export const TINYLYTICS_SCRIPT = 'https://tinylytics.app/js/script.js';

/** The pixel's address, its hits landing on `path` in the site's numbers. */
export const tinylyticsPixel = (path: string): string =>
  `https://tinylytics.app/pixel/${TINYLYTICS_SITE}.gif?path=${encodeURI(path)}`;
