const express = require('express');
const path = require('path');

const app = express();

app.use(express.static(path.join(__dirname, 'public')));

// Returns the URL for each sub-app.
// In Electron mode main.js sets these to localhost ports before starting this server.
// In web/Render mode they come from environment variables set in the Render dashboard.
app.get('/api/app-urls', (req, res) => {
  res.json({
    hotelFinder: process.env.HOTEL_FINDER_URL || null,
    hotelInfo:   process.env.HOTEL_INFO_URL   || null,
    genbaInfo:   process.env.GENBA_INFO_URL   || null,
  });
});

function start(port) {
  return new Promise((resolve, reject) => {
    const srv = app.listen(port, () => {
      console.log(`Trip Assistant running at http://localhost:${port}`);
      resolve(srv);
    });
    srv.on('error', reject);
  });
}

if (require.main === module) {
  start(process.env.PORT || 3000);
}

module.exports = { start };
