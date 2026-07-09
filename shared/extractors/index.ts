import type { JobInfo } from '../types';
import { extractFromJsonLd } from './jsonLd';
import { extractFromOpenGraph } from './openGraph';
import { extractFromHeadings } from './headingHeuristics';

/**
 * Extract job info with fallback chain:
 *   JSON-LD (most reliable) → Open Graph → heading heuristics
 */
export function extractJobInfo(doc: Document = document): JobInfo {
  const jsonLd = extractFromJsonLd(doc);
  const og = extractFromOpenGraph(doc);
  const headings = extractFromHeadings(doc);

  return {
    company: jsonLd.company ?? og.company ?? headings.company,
    position: jsonLd.position ?? og.position ?? headings.position,
    description: jsonLd.description,
  };
}

export { extractFromJsonLd } from './jsonLd';
export { extractFromOpenGraph } from './openGraph';
export { extractFromHeadings } from './headingHeuristics';
