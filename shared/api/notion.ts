import type { ApplicationEntry } from '../types';

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

export async function logToNotion(
  entry: ApplicationEntry,
  token: string,
  databaseId: string,
): Promise<void> {
  const response = await fetch(`${NOTION_API}/pages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
    },
    body: JSON.stringify({
      parent: { database_id: databaseId },
      properties: {
        Name: { title: [{ text: { content: entry.position || 'Unknown position' } }] },
        Company: { rich_text: [{ text: { content: entry.company || '' } }] },
        URL: { url: entry.url },
        Date: { date: { start: entry.timestamp } },
        Status: { select: { name: entry.status } },
        Profile: { rich_text: [{ text: { content: entry.profileId } }] },
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Notion API error ${response.status}: ${body.slice(0, 200)}`);
  }
}
