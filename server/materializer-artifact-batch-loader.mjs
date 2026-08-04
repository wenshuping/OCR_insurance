function text(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

export function materializerProductIdentity(product = {}) {
  return `${text(product.company)}\u001f${text(product.productName ?? product.product_name)}\u001f${text(product.sourceDigest ?? product.source_digest)}`;
}

export function prefetchMaterializerArtifacts({ db, products = [], query = null } = {}) {
  if (!db && !query) throw new Error('db or query is required');
  const uniqueProducts = [...new Map(products.map((product) => [materializerProductIdentity(product), product])).values()];
  if (uniqueProducts.length !== products.length) throw new Error('duplicate materializer product identity');
  if (!uniqueProducts.length) return new Map();
  const clauses = uniqueProducts.map(() => '(company = ? AND product_name = ? AND source_digest = ?)').join(' OR ');
  const params = uniqueProducts.flatMap((product) => [product.company, product.productName, product.sourceDigest]);
  const statement = `SELECT company, product_name, source_digest, payload FROM product_responsibility_artifacts WHERE ${clauses} ORDER BY id DESC`;
  const rows = query ? query(statement, params) : db.prepare(statement).all(...params);
  const artifacts = new Map();
  for (const row of rows) {
    const identity = materializerProductIdentity(row);
    if (!artifacts.has(identity)) artifacts.set(identity, JSON.parse(row.payload || '{}'));
  }
  for (const product of uniqueProducts) {
    if (!artifacts.has(materializerProductIdentity(product))) {
      throw new Error(`missing materializer artifact: ${materializerProductIdentity(product)}`);
    }
  }
  return artifacts;
}
