const fs = require('fs');
const path = require('path');
const http = require('http');
const { URL } = require('url');
const { google } = require('googleapis');

const TOKEN_PATH = path.join(process.cwd(), 'token.json');
const SCOPES = ['https://www.googleapis.com/auth/calendar'];
const REDIRECT_PORT = 3000;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth2callback`;

function createOAuth2Client() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      'Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env file'
    );
  }

  return new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
}

function loadToken() {
  if (!fs.existsSync(TOKEN_PATH)) return null;
  const raw = fs.readFileSync(TOKEN_PATH, 'utf-8');
  return JSON.parse(raw);
}

function saveToken(token) {
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2), 'utf-8');
}

async function authorize() {
  const oauth2Client = createOAuth2Client();
  const savedToken = loadToken();

  if (savedToken) {
    oauth2Client.setCredentials(savedToken);

    // Refresh if expired
    if (savedToken.expiry_date && savedToken.expiry_date < Date.now()) {
      try {
        const { credentials } = await oauth2Client.refreshAccessToken();
        oauth2Client.setCredentials(credentials);
        saveToken(credentials);
      } catch (err) {
        console.log('Token refresh failed, re-authenticating...');
        return runAuthFlow(oauth2Client);
      }
    }

    return oauth2Client;
  }

  return runAuthFlow(oauth2Client);
}

function runAuthFlow(oauth2Client) {
  return new Promise((resolve, reject) => {
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      prompt: 'consent',
    });

    console.log('\nGoogle Calendar Authorization Required');
    console.log('======================================');
    console.log('Open this URL in your browser:\n');
    console.log(authUrl);
    console.log('\nWaiting for authorization...\n');

    let resolved = false;

    // Start the local callback server
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
        if (url.pathname !== '/oauth2callback') {
          res.writeHead(404);
          res.end('Not found');
          return;
        }

        const code = url.searchParams.get('code');
        if (!code) {
          res.writeHead(400);
          res.end('No authorization code received');
          return;
        }

        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);
        saveToken(tokens);

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          '<html><body><h2>Authorization successful!</h2><p>You can close this window and return to the terminal.</p></body></html>'
        );

        resolved = true;
        server.close();
        if (rlInterface) rlInterface.close();
        console.log('Authorization successful! Token saved to token.json\n');
        resolve(oauth2Client);
      } catch (err) {
        res.writeHead(500);
        res.end('Authorization failed');
        server.close();
        if (rlInterface) rlInterface.close();
        reject(err);
      }
    });

    // Also offer manual code entry for environments where localhost isn't reachable
    const readline = require('readline');
    let rlInterface = null;

    function startManualEntry() {
      console.log('If localhost is not reachable, after authorizing in the browser,');
      console.log('copy the FULL redirect URL from your browser address bar and paste it here.');
      console.log('(It will start with http://localhost:3000/oauth2callback?code=...)\n');

      rlInterface = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      rlInterface.question('Paste redirect URL or authorization code: ', async (input) => {
        if (resolved) return;
        try {
          let code = input.trim();
          // Extract code from full URL if pasted
          if (code.startsWith('http')) {
            const url = new URL(code);
            code = url.searchParams.get('code');
          }
          if (!code) {
            console.error('No authorization code found in input.');
            rlInterface.close();
            return;
          }

          const { tokens } = await oauth2Client.getToken(code);
          oauth2Client.setCredentials(tokens);
          saveToken(tokens);

          resolved = true;
          server.close();
          rlInterface.close();
          console.log('Authorization successful! Token saved to token.json\n');
          resolve(oauth2Client);
        } catch (err) {
          rlInterface.close();
          server.close();
          reject(err);
        }
      });
    }

    server.listen(REDIRECT_PORT, () => {
      // Try to open browser automatically
      const { exec } = require('child_process');
      const openCmd =
        process.platform === 'darwin'
          ? 'open'
          : process.platform === 'win32'
            ? 'start'
            : 'xdg-open';
      exec(`${openCmd} "${authUrl}"`, () => {
        // Silently ignore if browser can't be opened
      });

      startManualEntry();
    });

    server.on('error', (err) => {
      // If server can't start, fall back to manual-only entry
      console.log('Could not start local callback server, using manual code entry.\n');
      startManualEntry();
    });
  });
}

module.exports = { authorize, createOAuth2Client };
