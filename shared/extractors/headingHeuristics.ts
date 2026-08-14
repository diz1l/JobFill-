import type { JobInfo } from '../types';

/** Last-resort extraction from the page's <h1> and <title>. */
export function extractFromHeadings(doc: Document = document): Partial<JobInfo> {
  const h1 = doc.querySelector('h1')?.textContent?.trim();
  const titleRaw = doc.title?.trim();

  // H1 beats <title>: it is the most specific visible heading on the page.
  const position = h1 || undefined;

  // Extract company from <title>: "Job Title - Company Name | Site"
  let company: string | undefined;
  if (titleRaw) {
    const separators = [' - ', ' | ', ' — ', ' · ', ' at ', ' @ '];
    for (const sep of separators) {
      const parts = titleRaw.split(sep);
      if (parts.length >= 2) {
        const lastPart = parts[parts.length - 1].trim();
        if (lastPart.length > 0 && lastPart.length < 60) {
          company = lastPart;
          break;
        }
      }
    }
  }

  return { position, company };
}
