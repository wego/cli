// Ambient type for the `with { type: "file" }` asset import in skill-embed.ts.
// Bun replaces such an import with a path string to the embedded file at build
// time; TypeScript only needs to know the default export is a string.
declare module "*.md" {
  const path: string;
  export default path;
}
