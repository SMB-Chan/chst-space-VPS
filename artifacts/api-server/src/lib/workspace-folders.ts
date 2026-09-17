/**
 * Folder-name derivation shared by the project registry and the file browser.
 * Both sides must agree on the mapping so deleting one side can find and
 * remove the other. This mirrors the historical normalization inside
 * createProjectFolder; changing it orphans existing folder/project pairs.
 */
export function projectNameToFolder(name: string): string {
  const safe = name
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .slice(0, 80);
  return safe || `project-${Date.now()}`;
}
