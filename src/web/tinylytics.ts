// Tinylytics counts visits: the site's pages load its script, and the sign-in email carries its
// pixel. Neither sets cookies or keeps anything about a person; the pixel's path is the same for
// every email, so it counts emails opened, never who opened one. The site id is public: it is in
// every page.
//
// Events (on in the site's Tinylytics settings, with the beacon so a click that leaves the page
// still lands) count clicks on links tagged `data-tinylytics-event`, per click and never per
// person: `app.get` for the links to the app section (value: `header`, or `sign` for a sign's
// "Find another way in the app"), and `beta.join` for the TestFlight invite (value: `home`).

export const TINYLYTICS_SITE = 'ryhTaXDDgZtyCktoVzzj';

export const TINYLYTICS_SCRIPT = 'https://tinylytics.app/js/script.js';

/** The pixel's address, its hits landing on `path` in the site's numbers. */
export const tinylyticsPixel = (path: string): string =>
  `https://tinylytics.app/pixel/${TINYLYTICS_SITE}.gif?path=${encodeURI(path)}`;
