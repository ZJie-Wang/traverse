export function vaultParentPath(path: string): string {
	const index = path.lastIndexOf("/");
	return index < 0 ? "/" : path.slice(0, index) || "/";
}

export function isPathWithinFolder(path: string, folderPath: string): boolean {
	return folderPath === "" || folderPath === "/" || path === folderPath || path.startsWith(`${folderPath}/`);
}

export function isListingMutationPathRelevant(currentFolderPath: string, path: string): boolean {
	const current = currentFolderPath === "" ? "/" : currentFolderPath;
	const parent = vaultParentPath(path);
	if (parent === current || path === current || (path.length > 0 && current.startsWith(`${path}/`))) return true;
	// Folder Notes stored inside a direct child folder can change that child's row.
	return vaultParentPath(parent) === current;
}

export function visibleSelectedPaths(selected: Iterable<string>, visible: Iterable<string>): string[] {
	const visiblePaths = new Set(visible);
	return Array.from(selected).filter((path) => visiblePaths.has(path));
}
