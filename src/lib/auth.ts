import { createHash, randomBytes } from 'node:crypto';
import { compare } from 'bcryptjs';
import Redis from 'ioredis';
import { db } from './db';

const COOKIE = 'crm_session';
const SESSION_SECONDS = 12 * 60 * 60;
export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export function assertMutationOrigin(request: Request) {
  const configured = process.env.APP_URL;
  if (!configured) throw new HttpError(503, 'APP_URL não configurada.');
  const allowed = new URL(configured).origin;
  const origin = request.headers.get('origin');
  if (origin !== allowed || request.headers.get('sec-fetch-site') === 'cross-site') {
    throw new HttpError(403, 'Origem da requisição não autorizada.');
  }
}
function tokenFrom(request: Request): string | null {
  const raw = request.headers.get('cookie')?.split(';').map(v => v.trim()).find(v => v.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  return raw && /^[a-f0-9]{64}$/.test(raw) ? raw : null;
}
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
export async function getUser(request: Request) {
  const token = tokenFrom(request);
  if (!token) return null;
  const session = await db.session.findUnique({where: {tokenHash: digest(token)}, include: {user: {select: {id: true, email: true, name: true, role: true}}}});
  if (!session || session.expiresAt <= new Date()) return null;
  return session.user;
}
export async function requireUser(request: Request, roles?: string[]) {
  const user = await getUser(request);
  if (!user) throw new HttpError(401, 'Faça login para continuar.');
  if (roles && !roles.includes(user.role)) throw new HttpError(403, 'Permissão insuficiente.');
  return user;
}
let redis: Redis | undefined;
function authRedis() {
  if (!redis) { redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {maxRetriesPerRequest: 1, lazyConnect: true, enableOfflineQueue: false}); redis.on('error', () => {}); }
  return redis;
}
async function throttle(email: string) {
  const client = authRedis();
  if (client.status === 'wait') await client.connect();
  const key = `crm:login:${digest(email)}`;
  const count = Number(await client.eval("local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],900) end; return n", 1, key));
  if (count > 10) throw new HttpError(429, 'Muitas tentativas. Aguarde 15 minutos.');
}
function cookie(value: string, age: number) {
  const secure = new URL(process.env.APP_URL || 'http://localhost:3000').protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure}`;
}
export async function login(request: Request, email: string, password: string): Promise<Response> {
  assertMutationOrigin(request);
  if (typeof email !== 'string' || typeof password !== 'string' || password.length > 200 || email.length > 254) throw new HttpError(400, 'Credenciais inválidas.');
  email = email.trim().toLowerCase();
  try { await throttle(email); } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(503, 'Serviço de autenticação temporariamente indisponível.'); }
  const user = await db.user.findUnique({where: {email}});
  // Fixed dummy bcrypt hash keeps missing users on the same expensive validation path.
  const valid = await compare(password, user?.passwordHash || '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6Ttx5qYr1wqMvaTiJ.ZKz1dPR8WGa');
  if (!user || !valid) throw new HttpError(401, 'E-mail ou senha incorretos.');
  const token = randomBytes(32).toString('hex');
  await db.$transaction([
    db.session.deleteMany({where: {expiresAt: {lt: new Date()}}}),
    db.session.create({data: {tokenHash: digest(token), userId: user.id, expiresAt: new Date(Date.now() + SESSION_SECONDS * 1000)}}),
    db.auditLog.create({data: {userId: user.id, action: 'LOGIN'}}),
  ]);
  await authRedis().del(`crm:login:${digest(email)}`);
  return Response.json({user: {id: user.id, email: user.email, name: user.name, role: user.role}}, {headers: {'Set-Cookie': cookie(token, SESSION_SECONDS), 'Cache-Control': 'no-store'}});
}
export async function logout(request: Request): Promise<Response> {
  assertMutationOrigin(request);
  const token = tokenFrom(request);
  if (token) await db.session.deleteMany({where: {tokenHash: digest(token)}});
  return Response.json({ok: true}, {headers: {'Set-Cookie': cookie('', 0)}});
}
