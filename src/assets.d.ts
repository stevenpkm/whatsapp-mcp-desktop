// The font is bundled into the page as base64, so the page loads nothing from the internet.
declare module "*.woff2" {
  const base64: string;
  export default base64;
}
