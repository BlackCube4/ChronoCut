// Node verlangt die .js-Endung, Vite nicht. Dieser Resolver-Hook haengt sie an,
// damit verify_js.mjs den unveraenderten Frontend-Quellcode importieren kann.
export async function resolve(spec, ctx, next) {
  try { return await next(spec, ctx) }
  catch (e) {
    if (spec.startsWith('.')) return await next(spec + '.js', ctx)
    throw e
  }
}
