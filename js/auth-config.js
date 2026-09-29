// Single sign-on (OpenID Connect) providers for the self-hosted app.
//
// Leave the list empty to run without sign-in. Add one or more providers to
// require sign-in: each person then gets their own board, and their name
// is shown in the top bar.
//
// For every provider, register a "single-page application" (public client,
// authorization code flow with PKCE, no client secret) and add the exact
// URL the app is served from as an allowed redirect URI, e.g.
// https://tasks.example.com/ (and http://localhost:3000/ for local testing).
//
// Fields:
//   id        short unique key, used to keep each person's board separate
//   label     button text: "Continue with <label>"
//   issuer    the provider's OpenID issuer URL (discovery must be reachable
//             at <issuer>/.well-known/openid-configuration)
//   clientId  the application / client id from the provider
//   scopes    optional, defaults to "openid profile email"
//   params    optional extra authorization parameters (e.g. { prompt: 'select_account' })
//
// When hosted as a claude.ai artifact, the claude.ai account is used instead
// and this list is ignored.

export const SSO_PROVIDERS = [
  // Microsoft Entra ID (Azure AD / Microsoft 365):
  // {
  //   id: 'microsoft',
  //   label: 'Microsoft',
  //   issuer: 'https://login.microsoftonline.com/<tenant-id>/v2.0',
  //   clientId: '<application-client-id>',
  //   params: { prompt: 'select_account' },
  // },

  // Okta:
  // {
  //   id: 'okta',
  //   label: 'Okta',
  //   issuer: 'https://<your-org>.okta.com/oauth2/default',
  //   clientId: '<client-id>',
  // },

  // Auth0 (can also front Google Workspace, GitHub, SAML, ...):
  // {
  //   id: 'auth0',
  //   label: 'Auth0',
  //   issuer: 'https://<your-tenant>.auth0.com/',
  //   clientId: '<client-id>',
  // },

  // Keycloak:
  // {
  //   id: 'keycloak',
  //   label: 'Company SSO',
  //   issuer: 'https://sso.example.com/realms/<realm>',
  //   clientId: 'taskflow',
  // },
];
