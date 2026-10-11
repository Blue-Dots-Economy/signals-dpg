import { readFile, readdir } from 'node:fs/promises';

/**
 * Filesystem primitives shared by the `.properties` layer loaders (email copy,
 * SMS templates).
 *
 * Only the I/O lives here — deliberately nothing else. The two loaders stay
 * separate because their formats merge under opposite rules (an empty email
 * value falls back to the layer below; an empty SMS `template_id` is a
 * meaningful "not DLT-approved, skip the send" signal), and none of that
 * belongs in a file reader. What they genuinely share is "read this file if it
 * exists" and "list the brand sub-folders", which is what this module is.
 */

/**
 * Read a layer file, or null when it isn't there.
 *
 * Only ENOENT is absence. Anything else — a permissions error, a directory
 * where a file belongs — is a real misconfiguration and rethrows, so a
 * deployment that half-mounted its config fails loudly rather than silently
 * serving bundled content.
 */
export async function readOptionalPropertiesFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * The immediate sub-directories of a network folder — each one a brand id.
 *
 * A missing or non-directory path simply means "no brands", since the network
 * folder itself is optional in every caller.
 */
export async function listBrandDirectories(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw err;
  }
}
