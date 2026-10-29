import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith(".") &&
      !/\.(?:[cm]?js|json|node|ts|tsx)$/.test(specifier)
    ) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        // Let the default resolver produce the useful error for other modules.
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith("/src/lib/supabase.ts")) {
      return {
        format: "module",
        shortCircuit: true,
        source: "export const supabase = globalThis.__VEYLITH_TEST_SUPABASE__;",
      };
    }
    return nextLoad(url, context);
  },
});
