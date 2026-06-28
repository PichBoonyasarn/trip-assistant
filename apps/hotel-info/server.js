require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '1mb' }));

app.use('/api/config', require('./routes/config'));
app.use('/api/poi', require('./routes/poi'));
app.use('/api/routes', require('./routes/routePlanning'));
app.use('/api/static-map', require('./routes/staticMap'));
app.use('/api/document', require('./routes/documentGen'));

function start(port) {
  return new Promise((resolve, reject) => {
    const srv = app.listen(port, () => {
      console.log(`Hotel Info running at http://localhost:${port}`);
      resolve(srv);
    });
    srv.on('error', reject);
  });
}

if (require.main === module) {
  start(process.env.PORT || 3000);
}

module.exports = { start };
