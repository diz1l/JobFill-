import type { JobInfo } from '../types';

/**
 * Extract job info from JSON-LD JobPosting structured data.
 * Priority: most reliable source — present on major job boards.
 */
export function extractFromJsonLd(doc: Document = document): Partial<JobInfo> {
  const scripts = doc.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]');

  for (const script of scripts) {
    try {
      const data = JSON.parse(script.textContent ?? '');
      const nodes: unknown[] = Array.isArray(data) ? data : [data];

      for (const node of nodes) {
        const jobPosting = findJobPosting(node);
        if (jobPosting) {
          return {
            company: jobPosting.hiringOrganization?.name ?? undefined,
            position: jobPosting.title ?? undefined,
            description: stripHtml(jobPosting.description ?? ''),
          };
        }
      }
    } catch {
      // Malformed JSON-LD — skip
    }
  }

  return {};
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findJobPosting(node: any): any | null {
  if (!node || typeof node !== 'object') return null;

  const type = node['@type'];
  if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) {
    return node;
  }

  // Walk @graph
  if (Array.isArray(node['@graph'])) {
    for (const item of node['@graph']) {
      const found = findJobPosting(item);
      if (found) return found;
    }
  }

  return null;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000);
}
