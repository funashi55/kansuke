import axios from 'axios';

const CHANNEL_ID = process.env.LINE_LOGIN_CHANNEL_ID;
const SKIP = process.env.SKIP_OIDC_VERIFY === '1';

export async function verifyLiffIdToken(idToken) {
  if (SKIP) {
    return { sub: 'debug-user', name: 'Debug User' };
  }
  if (!idToken || !CHANNEL_ID) {
    throw new Error('Missing idToken or LINE_LOGIN_CHANNEL_ID');
  }
  // Use LINE verify endpoint
  // POST x-www-form-urlencoded: id_token, client_id
  const params = new URLSearchParams();
  params.set('id_token', idToken);
  params.set('client_id', CHANNEL_ID);
  const resp = await axios.post('https://api.line.me/oauth2/v2.1/verify', params, {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    timeout: 10000,
  });
  return resp.data; // contains sub, name, picture, email?, etc.
}

