import { readFile, readdir } from 'node:fs/promises';

/**
 * Filesystem primitives shared by the `.properties` layer loaders (email copy,
 * SMS templates). Merge rules differ between the two and stay in the loaders.
 */

/**
 * Read a layer file, or null when it does not exist. Any other error rethrows,
 * so a half-mounted config fails loudly instead of serving bundled content.
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
 * The immediate sub-directories of a network folder, each a brand id. A missing
 * or non-directory path means no brands.
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
