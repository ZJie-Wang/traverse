import { existsSync, readFileSync, statSync } from "node:fs";

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const versions = JSON.parse(readFileSync("versions.json", "utf8"));
const requiredManifestFields = ["id", "name", "version", "minAppVersion", "description", "author", "isDesktopOnly"];

for (const field of requiredManifestFields) {
	if (manifest[field] === undefined || manifest[field] === "") throw new Error(`manifest.json is missing ${field}`);
}
if (manifest.id !== "traverse" || manifest.name !== "Traverse") throw new Error("Plugin identity must be Traverse / traverse");
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error("Plugin version must use x.y.z SemVer");
if (manifest.version !== packageJson.version) throw new Error("manifest.json and package.json versions do not match");
if (versions[manifest.version] !== manifest.minAppVersion) throw new Error("versions.json does not match manifest.json");
if (manifest.description.length > 250 || !manifest.description.endsWith(".")) throw new Error("Manifest description must end with a period and stay within 250 characters");
if (process.env.GITHUB_REF_TYPE === "tag" && process.env.GITHUB_REF_NAME !== manifest.version) {
	throw new Error(`Release tag ${process.env.GITHUB_REF_NAME} does not match version ${manifest.version}`);
}
for (const file of ["main.js", "manifest.json", "styles.css"]) {
	if (!existsSync(file) || statSync(file).size === 0) throw new Error(`Missing release asset: ${file}`);
}

console.log(`Release metadata and assets are valid for Traverse ${manifest.version}.`);
