/** Pinned Prisma 6.19.0 internal generation API; no native engine downloads. */
import path from 'node:path';
import { createRequire } from 'node:module';
import { getGenerators } from '@prisma/internals';

const require = createRequire(import.meta.url);
async function main() {
  const generators = await getGenerators({
    schemaPath: path.resolve('prisma/schema.prisma'),
    registry: {
      'prisma-client-js': { type: 'rpc', generatorPath: require.resolve('@prisma/client/generator-build'), isNode: true },
    },
    skipDownload: true,
    noEngine: false,
    printDownloadProgress: false,
  });
  try {
    for (const generator of generators) {
      await generator.generate();
      console.log(`${generator.getPrettyName()} generated with the JavaScript client engine.`);
    }
  } finally {
    for (const generator of generators) generator.stop();
  }
}
let completed = false;
process.once('beforeExit', () => { if (!completed) { console.error('Prisma generation did not finish. Check subprocess permissions.'); process.exitCode = 1; } });
main().then(() => { completed = true; }).catch(error => { completed = true; console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
