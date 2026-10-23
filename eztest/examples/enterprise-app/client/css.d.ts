/** esbuild bundles .css imports as text (see server.ts), injected with a <style> element. */
declare module '*.css' {
  const text: string;
  export default text;
}
