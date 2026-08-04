import assert from 'node:assert/strict';
import test from 'node:test';
import { materializerProductIdentity, prefetchMaterializerArtifacts } from '../server/materializer-artifact-batch-loader.mjs';

test('materializer artifact prefetch performs one bounded batch query and preserves product identity', () => {
  const products = Array.from({ length: 20 }, (_, index) => ({
    company: index < 10 ? 'A' : 'B',
    productName: `product-${index}`,
    sourceDigest: `sha256:${index}`,
  }));
  let queryCount = 0;
  let queryText = '';
  let queryParams = [];
  const artifacts = prefetchMaterializerArtifacts({
    products,
    query(statement, params) {
      queryCount += 1;
      queryText = statement;
      queryParams = params;
      return products.map((product) => ({
        ...product,
        product_name: product.productName,
        source_digest: product.sourceDigest,
        payload: JSON.stringify({ company: product.company, productName: product.productName, sourceDigest: product.sourceDigest }),
      }));
    },
  });
  assert.equal(queryCount, 1);
  assert.equal((queryText.match(/source_digest = \?/g) || []).length, 20);
  assert.equal(queryParams.length, 60);
  assert.equal(artifacts.size, 20);
  for (const product of products) {
    assert.deepEqual(artifacts.get(materializerProductIdentity(product)), product);
  }
});
