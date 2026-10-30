// apple-app-site-association: which roadsignmath.xyz links open the iPhone app instead of Safari.
// Apple's CDN fetches it from /.well-known/ (the root copy is for older fetchers) and wants JSON
// with no redirect. The app is named by the team's id; without one (npm run dev, tests that
// don't set it) the file isn't served.

/** The iPhone app's bundle id. */
export const APP_BUNDLE_ID = 'xyz.roadsignmath.app';

/** A Team ID is ten capital letters and digits. */
export const TEAM_ID = /^[A-Z0-9]{10}$/;

/**
 * The links the app opens: the sign-in link the email carries (`/signin?l=…&t=…`, built in
 * src/api/app.ts) and a sign's page, which the app shows as that sign. Everything else, the
 * home page included, stays in the browser.
 */
export function appSiteAssociation(teamId: string) {
  return {
    applinks: {
      details: [
        {
          appIDs: [`${teamId}.${APP_BUNDLE_ID}`],
          components: [
            { '/': '/signin', comment: 'The sign-in link in the email' },
            { '/': '/signs/?*', comment: 'A sign’s page' }
          ]
        }
      ]
    }
  };
}
