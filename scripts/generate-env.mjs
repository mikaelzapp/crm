import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const target = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(target)) {
  console.log('.env existente preservado.');
} else {
  const postgres = randomBytes(24).toString('hex');
  const admin = randomBytes(18).toString('hex');
  const encryption = randomBytes(32).toString('hex');
  const contents = readFileSync(new URL('../.env.example', import.meta.url), 'utf8')
    .replaceAll('CHANGE_ME_POSTGRES', postgres)
    .replaceAll('CHANGE_ME_ADMIN', admin)
    .replaceAll('CHANGE_ME_ENCRYPTION', encryption);
  writeFileSync(target, contents, { mode: 0o600, flag: 'wx' });
  console.log('.env criado com segredos aleatórios. Consulte ADMIN_EMAIL e ADMIN_PASSWORD no arquivo local para entrar.');
}
