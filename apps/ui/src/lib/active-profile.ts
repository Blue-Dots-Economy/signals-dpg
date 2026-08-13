/**
 * Persistence for the user's currently-selected own-profile ("active profile")
 * per network. Stored in localStorage so the choice survives reloads. Shared by
 * the home page (reads it to anchor the discover list + sidebar highlight) and
 * the profile form (writes it so a freshly-created profile becomes active).
 */
function key(networkId: string): string {
  return `activeProfileId:${networkId}`;
}

export function getStoredActiveProfileId(networkId: string): string | null {
  return localStorage.getItem(key(networkId));
}

export function setStoredActiveProfileId(networkId: string, profileId: string): void {
  localStorage.setItem(key(networkId), profileId);
}

export function clearStoredActiveProfileId(networkId: string): void {
  localStorage.removeItem(key(networkId));
}
