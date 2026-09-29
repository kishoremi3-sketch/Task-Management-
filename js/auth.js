// Browser-only OpenID Connect sign-in (authorization code flow + PKCE).
//
// This identifies who is using the app so each person sees their own board.
// Boards in the self-hosted app live in the browser, so the ID token is used
// for identity only; it is checked for issuer, audience, nonce and expiry,
// but its signature is not verified here. Anything that must be protected
// server-side needs a backend that verifies tokens.

import { SSO_PROVIDERS } from './auth-config.js';

const SESSION_KEY = 'taskflow.sso.session';
const PENDING_KEY = 'taskflow.sso.pending';

export function ssoProviders(providers = SSO_PROVIDERS) {
  return providers.filter((p) => p && p.id && p.issuer && p.clientId);
}

function trimSlash(url) {
  return url.replace(/\/+$/, '');
}

function base64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(bytes = 32) {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export function decodeJwt(token) {
  const part = String(token).split('.')[1];
  if (!part) throw new Error('Malformed ID token.');
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

// Checks the ID token claims that matter for a public browser client.
// Returns the list of problems (empty when valid).
export function validateClaims(claims, { issuer, clientId, nonce, now = Date.now() }) {
  const problems = [];
  if (!claims || typeof claims !== 'object') return ['missing claims'];
  // Entra's multi-tenant "common" issuer has a {tenantid} placeholder.
  const expectedIss = trimSlash(issuer);
  const iss = trimSlash(String(claims.iss ?? ''));
  const issOk = expectedIss.includes('{tenantid}')
    ? new RegExp(`^${expectedIss.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\{tenantid\\}', '[^/]+')}$`).test(iss)
    : iss === expectedIss;
  if (!issOk) problems.push('issuer mismatch');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(clientId)) problems.push('audience mismatch');
  if (nonce && claims.nonce !== nonce) problems.push('nonce mismatch');
  if (!Number.isFinite(claims.exp) || claims.exp * 1000 < now - 60_000) problems.push('token expired');
  if (!claims.sub) problems.push('missing subject');
  return problems;
}

export function displayName(claims) {
  return claims.name
    || [claims.given_name, claims.family_name].filter(Boolean).join(' ')
    || claims.preferred_username
    || claims.email
    || 'Signed-in user';
}

function redirectUri() {
  return `${location.origin}${location.pathname}`;
}

async function discover(provider) {
  const res = await fetch(`${trimSlash(provider.issuer)}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`Couldn't reach ${provider.label ?? provider.id} (HTTP ${res.status}).`);
  return res.json();
}

export async function signIn(providerId) {
  const provider = ssoProviders().find((p) => p.id === providerId);
  if (!provider) throw new Error(`Unknown sign-in provider "${providerId}".`);
  const meta = await discover(provider);
  const pending = {
    providerId,
    state: randomString(),
    nonce: randomString(),
    verifier: randomString(48),
    tokenEndpoint: meta.token_endpoint,
    endSessionEndpoint: meta.end_session_endpoint ?? null,
    redirectUri: redirectUri(),
  };
  sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));

  const url = new URL(meta.authorization_endpoint);
  const params = {
    response_type: 'code',
    client_id: provider.clientId,
    redirect_uri: pending.redirectUri,
    scope: provider.scopes ?? 'openid profile email',
    state: pending.state,
    nonce: pending.nonce,
    code_challenge: await pkceChallenge(pending.verifier),
    code_challenge_method: 'S256',
    ...provider.params,
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  location.assign(url.toString());
}

// Completes sign-in when the provider redirects back with ?code=&state=.
// Returns the new session, or null when this page load is not a callback.
export async function handleRedirect() {
  const params = new URLSearchParams(location.search);
  if (!params.has('state') || !(params.has('code') || params.has('error'))) return null;

  const pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) || 'null');
  sessionStorage.removeItem(PENDING_KEY);
  history.replaceState(null, '', `${location.pathname}${location.hash}`);

  if (params.get('error')) {
    throw new Error(params.get('error_description') || `Sign-in failed: ${params.get('error')}`);
  }
  if (!pending || pending.state !== params.get('state')) {
    throw new Error('The sign-in response didn’t match this browser tab. Please sign in again.');
  }
  const provider = ssoProviders().find((p) => p.id === pending.providerId);
  if (!provider) throw new Error('That sign-in provider is no longer configured.');

  const res = await fetch(pending.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: params.get('code'),
      redirect_uri: pending.redirectUri,
      client_id: provider.clientId,
      code_verifier: pending.verifier,
    }),
  });
  const tokens = await res.json().catch(() => ({}));
  if (!res.ok || !tokens.id_token) {
    throw new Error(tokens.error_description || tokens.error || `Sign-in failed (HTTP ${res.status}).`);
  }

  const claims = decodeJwt(tokens.id_token);
  const problems = validateClaims(claims, { issuer: provider.issuer, clientId: provider.clientId, nonce: pending.nonce });
  if (problems.length) throw new Error(`Sign-in was rejected: ${problems.join(', ')}.`);

  const session = {
    providerId: provider.id,
    providerLabel: provider.label ?? provider.id,
    sub: String(claims.sub),
    name: displayName(claims),
    email: claims.email ?? null,
    expiresAt: claims.exp * 1000,
    idToken: tokens.id_token,
    endSessionEndpoint: pending.endSessionEndpoint,
  };
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}

export function currentSession() {
  try {
    const session = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    if (!session) return null;
    const stillConfigured = ssoProviders().some((p) => p.id === session.providerId);
    if (!stillConfigured || session.expiresAt < Date.now()) {
      localStorage.removeItem(SESSION_KEY);
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

export function signOut() {
  const session = currentSession();
  try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
  if (session?.endSessionEndpoint) {
    const url = new URL(session.endSessionEndpoint);
    url.searchParams.set('id_token_hint', session.idToken);
    url.searchParams.set('post_logout_redirect_uri', redirectUri());
    location.assign(url.toString());
  } else {
    location.reload();
  }
}
