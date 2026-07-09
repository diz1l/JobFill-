import type { JobInfo } from '../types';

/**
 * Extract job info from Open Graph meta tags.
 * Used as a fallback when JSON-LD is absent.
 */
export function extractFromOpenGraph(doc: Document = document): Partial<JobInfo> {
  const get = (property: string): string | undefined => {
    const el = doc.querySelector<HTMLMetaElement>(`meta[property="${property}"]`);
    return el?.content?.trim() || undefined;
  };

  const title = get('og:title');
  const siteName = get('og:site_name');

  if (!title && !siteName) return {};

  // og:title is usually "Job Title at Company" or "Job Title | Company"
  let position: string | undefined;
  let company: string | undefined;

  if (title) {
    const separators = [' at ', ' bei ', ' chez ', ' @ ', ' | ', ' - ', ' — '];
    for (const sep of separators) {
      const idx = title.indexOf(sep);
      if (idx > 0) {
        position = title.slice(0, idx).trim();
        company = title.slice(idx + sep.length).trim();
        break;
      }
    }
    if (!position) position = title;
  }

  if (!company && siteName) {
    company = siteName;
  }

  return { company, position };
}
