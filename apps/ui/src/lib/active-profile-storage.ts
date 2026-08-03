// The user's last-selected ("active") profile id, per network, in localStorage.
// Shared by home-page (the profile switcher) and the post-login redirect (#376),
// so both read/write the exact same key.

function getActiveProfileStorageKey(networkId: string): string {
  return `activeProfileId:${networkId}`;
}

export function getStoredActiveProfileId(networkId: string): string | null {
  return localStorage.getItem(getActiveProfileStorageKey(networkId));
}

export function setStoredActiveProfileId(networkId: string, profileId: string): void {
  localStorage.setItem(getActiveProfileStorageKey(networkId), profileId);
}

export function clearStoredActiveProfileId(networkId: string): void {
  localStorage.removeItem(getActiveProfileStorageKey(networkId));
}
