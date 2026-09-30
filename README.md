# Polyfront server

This folder is everything online play needs: the web version of the game (`public/`) and the relay server
that connects players on the web, Windows and Android.

## Host it for free on Render

1. Make a free account on [github.com](https://github.com) and create a new repository (for example
   `polyfront-server`).
2. On the new repository's page, choose **Add file → Upload files**. Drag in everything from this folder,
   including the `public` folder, then press **Commit changes**.
3. Sign in to [render.com](https://render.com) with your GitHub account. Choose **New → Web Service** and
   pick the repository.
4. Use these settings, then create the service:
   - Language: **Node**
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: **Free**
5. After a few minutes Render shows your address, for example `https://polyfront-abcd.onrender.com`.
   - Anyone can open that link in a browser to play.
   - Windows and Android players type the address (`polyfront-abcd.onrender.com`) into the **Server** box on
     the Online page.

The free plan sleeps after about 15 minutes with nobody connected. The next person to visit waits roughly a
minute while it wakes up.

## How many players?

Measured with `loadtest.js` (full 12-player matches, protocol 3):

- CPU: one core handles about 180 players online at once; 100 players need about 0.6 of a core.
- Traffic: about 4 GB per hour (10 Mbit/s) with 100 players online; 12 players use about 0.5 GB per hour.

Rough fit on Render (plans and prices change, so check render.com/pricing):

| Plan | CPU | Comfortable players | Set MAX_PLAYERS to |
|---|---|---|---|
| Free | 0.1 | about 15 | 15 |
| Starter | 0.5 | about 80 | 80 |
| Standard | 1 | about 170 | 150 |

Set `MAX_PLAYERS` under the service's **Environment** tab. When the server is full, newcomers get "The server is
full right now" instead of everyone lagging. You can change the plan (Settings > Instance Type) at any time
without losing the address. Also check the plan's included bandwidth against the traffic above.

`https://your-address/health` shows how many players are online (`players`) and the limit (`maxPlayers`).

## Updating the game

After building a new web version, run **Prepare Deploy Folder.bat** in the project folder again, then upload the
new `public` folder to the repository the same way. Render updates the site by itself.

## Running it on your own computer

With [Node.js](https://nodejs.org) installed: `npm install`, then `npm start`, and open http://localhost:8080.
