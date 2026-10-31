// AniList: the identity of a series (like TVDB for Sonarr). Public API, no key needed.
export interface AniManga {
  id: number;
  title: { romaji: string | null; english: string | null; native: string | null };
  synonyms: string[];
  coverImage: { extraLarge: string | null; large: string | null };
  bannerImage: string | null;
  description: string | null;
  status: string | null;
  chapters: number | null;
  format: string | null;
  genres: string[];
  startDate: { year: number | null };
  staff: { edges: { role: string; node: { name: { full: string } } }[] };
}

const FIELDS = `id title { romaji english native } synonyms coverImage { extraLarge large } bannerImage
  description(asHtml: false) status chapters format genres startDate { year }
  staff(perPage: 4) { edges { role node { name { full } } } }`;

async function query<T>(q: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query: q, variables }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (!res.ok || body.errors?.length) throw new Error(`AniList: ${body.errors?.[0]?.message ?? res.status}`);
  return body.data as T;
}

export const manga = async (id: number) =>
  (await query<{ Media: AniManga | null }>(`query ($id: Int) { Media(id: $id, type: MANGA) { ${FIELDS} } }`, { id })).Media;

export const searchManga = async (term: string) =>
  (await query<{ Page: { media: AniManga[] } }>(
    `query ($q: String) { Page(perPage: 20) { media(search: $q, type: MANGA, sort: SEARCH_MATCH) { ${FIELDS} } } }`,
    { q: term },
  )).Page.media;

export const displayTitle = (m: AniManga) => m.title.english || m.title.romaji || m.title.native || `AniList ${m.id}`;

/** Every name the series goes by, best first: what sources get searched with. */
export const allTitles = (m: AniManga) =>
  [...new Set([m.title.english, m.title.romaji, ...m.synonyms, m.title.native].filter((t): t is string => !!t))];

export const author = (m: AniManga) =>
  m.staff.edges.filter((e) => /story|art/i.test(e.role)).map((e) => e.node.name.full).filter((n, i, a) => a.indexOf(n) === i).join(", ") || null;
