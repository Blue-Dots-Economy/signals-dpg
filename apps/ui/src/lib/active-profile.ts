/**
 * The user's selected own profile ("active profile") per network, kept in
 * localStorage so it survives reloads. For example, the home page reads it to
 * anchor the discover list, and the profile form sets a new profile active.
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
