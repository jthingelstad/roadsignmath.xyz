// The feeds of new signs: Atom at /feed.xml and JSON Feed 1.1 at /feed.json, and the same pair
// for each player at /players/<handle>/feed.xml and feed.json (the signs they found). An item is
// a sign: its page is the item's link and id, posted_at is when it was published and its newest
// way when it last changed. The content is the photos, the math as text (feed readers can't
// draw the site's LaTeX), the caption, who found it, when and where, and the other ways. No
// tracking pixel: none of the site's pages or files carry one per reader.

import { STATES } from '../domain/geo.ts';
import type { Player, Sign } from '../domain/types.ts';
import { signUrl } from '../api/views.ts';
import { newestUpdate, playerPageUrl, signRecord, type OpenData } from './data.ts';
import { longDay } from './layout.tsx';

/** How many signs a feed carries, newest posted first. */
export const FEED_SIZE = 50;

export type Feed = {
  title: string;
  description: string;
  /** The page the feed follows. */
  page: string;
  /** Where the feed files sit: `${base}/feed.xml` and `${base}/feed.json`. */
  base: string;
  signs: Sign[];
};

export function siteFeed(data: OpenData): Feed {
  return {
    title: 'Road Sign Math',
    description: 'New road signs players have found and made true, with the photo, the math and where it was.',
    page: `${data.urls.site}/`,
    base: data.urls.site,
    signs: data.signs.slice(0, FEED_SIZE)
  };
}

export function playerFeed(data: OpenData, player: Player): Feed {
  const page = playerPageUrl(data.urls, player);
  return {
    title: `${player.name} · Road Sign Math`,
    description: `Road signs ${player.name} found, newest first.`,
    page,
    base: page,
    signs: data.signs.filter((s) => s.finders.some((f) => f.playerId === player.id)).slice(0, FEED_SIZE)
  };
}

/** The `<link rel="alternate">` pair for a page's head. */
export const feedAlternates = (feed: Pick<Feed, 'title' | 'base'>, site: string) => {
  const path = feed.base.startsWith(site) ? feed.base.slice(site.length) : feed.base;
  return [
    { type: 'application/atom+xml', title: feed.title, href: `${path}/feed.xml` },
    { type: 'application/feed+json', title: feed.title, href: `${path}/feed.json` }
  ];
};

// XML 1.0 has no place for most control characters; drop them, then escape.
const xml = (text: string): string =>
  text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const names = (list: string[]): string =>
  list.length <= 2 ? list.join(' and ') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;

/** One sign as a feed item: its title, a one-line summary, and the content as HTML and as text. */
function itemOf(data: OpenData, sign: Sign) {
  const record = signRecord(data, sign);
  const finders = names(record.finders.map((f) => f.name));
  const [first, ...others] = record.ways;
  const found = `Found by ${finders} on ${longDay(record.found_on)}. ${record.place.label}.`;
  const math = first ? first.text : 'Nobody has solved it yet.';
  const html = [
    ...record.photos.map(
      (p) => `<p><img src="${xml(p.url)}" alt="${xml(p.alt)}" width="${p.width}" height="${p.height}"></p>`
    ),
    first ? `<p><strong>${xml(first.text)}</strong></p>` : `<p><em>${xml(math)}</em></p>`,
    ...(record.caption ? [`<p>${xml(record.caption)}</p>`] : []),
    `<p>${xml(found)}</p>`,
    ...(others.length
      ? [
          `<p>More ways to make it true:</p>`,
          `<ul>${others.map((w) => `<li>${xml(w.text)}${w.by ? ` (${xml(w.by.name || w.by.handle)})` : ''}</li>`).join('')}</ul>`
        ]
      : []),
    `<p><a href="${xml(record.url)}">See it on Road Sign Math</a></p>`
  ].join('\n');
  const text = [
    math,
    ...(record.caption ? [record.caption] : []),
    found,
    ...others.map((w) => `Another way: ${w.text}`),
    record.url
  ].join('\n\n');
  const tags = [
    record.place.state ? (STATES[record.place.state] ?? record.place.state) : null,
    record.found_on.slice(0, 4)
  ];
  return {
    record,
    summary: first ? `${first.text}. ${found}` : `${math} ${found}`,
    html,
    text,
    tags: tags.filter((t): t is string => !!t)
  };
}

/** A feed with no signs still needs a date; the Unix epoch keeps its bytes the same every time. */
const EMPTY_UPDATED = '1970-01-01T00:00:00.000Z';

export function atomFeed(data: OpenData, feed: Feed): string {
  const self = `${feed.base}/feed.xml`;
  const entries = feed.signs.map((sign) => {
    const { record, summary, html, tags } = itemOf(data, sign);
    return [
      '  <entry>',
      `    <title>${xml(record.title)}</title>`,
      `    <link href="${xml(record.url)}" rel="alternate" type="text/html"/>`,
      `    <id>${xml(record.url)}</id>`,
      `    <published>${record.posted_at}</published>`,
      `    <updated>${record.updated_at}</updated>`,
      ...record.finders.map(
        (f) => `    <author><name>${xml(f.name)}</name>${f.url ? `<uri>${xml(f.url)}</uri>` : ''}</author>`
      ),
      ...tags.map((t) => `    <category term="${xml(t)}"/>`),
      `    <summary type="text">${xml(summary)}</summary>`,
      `    <content type="html">${xml(html)}</content>`,
      '  </entry>'
    ].join('\n');
  });
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en">',
    `  <title>${xml(feed.title)}</title>`,
    `  <subtitle>${xml(feed.description)}</subtitle>`,
    `  <link href="${xml(feed.page)}" rel="alternate" type="text/html"/>`,
    `  <link href="${xml(self)}" rel="self" type="application/atom+xml"/>`,
    `  <id>${xml(feed.page)}</id>`,
    `  <updated>${newestUpdate(data, feed.signs) ?? EMPTY_UPDATED}</updated>`,
    `  <author><name>Road Sign Math</name><uri>${xml(data.urls.site)}/</uri></author>`,
    `  <icon>${xml(data.urls.site)}/favicon.svg</icon>`,
    ...entries,
    '</feed>',
    ''
  ].join('\n');
}

export function jsonFeed(data: OpenData, feed: Feed) {
  return {
    version: 'https://jsonfeed.org/version/1.1',
    title: feed.title,
    description: feed.description,
    home_page_url: feed.page,
    feed_url: `${feed.base}/feed.json`,
    favicon: `${data.urls.site}/favicon.svg`,
    language: 'en-US',
    authors: [{ name: 'Road Sign Math', url: `${data.urls.site}/` }],
    items: feed.signs.map((sign) => {
      const { record, summary, html, text, tags } = itemOf(data, sign);
      return {
        id: signUrl(data.urls, sign),
        url: record.url,
        title: record.title,
        summary,
        content_html: html,
        content_text: text,
        ...(record.photos[0] ? { image: record.photos[0].url } : {}),
        date_published: record.posted_at,
        date_modified: record.updated_at,
        authors: record.finders.map((f) => (f.url ? { name: f.name, url: f.url } : { name: f.name })),
        tags
      };
    })
  };
}
