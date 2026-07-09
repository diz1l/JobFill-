import type { ApplicationEntry } from '../types';

/**
 * POST an application entry to a user-deployed Google Apps Script Web App.
 * The endpoint must accept JSON POST with the ApplicationEntry shape.
 */
export async function logToSheets(entry: ApplicationEntry, endpoint: string): Promise<void> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry),
    redirect: 'follow', // Apps Script Web Apps often redirect
  });

  if (!response.ok) {
    throw new Error(`Sheets endpoint error: HTTP ${response.status}`);
  }
}
