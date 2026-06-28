const sharp = require('sharp');
const path = require('path');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="90" fill="#2f4338"/>
  <rect x="126" y="210" width="260" height="220" fill="white"/>
  <polygon points="256,95 90,218 422,218" fill="white"/>
  <rect x="206" y="318" width="100" height="112" rx="6" fill="#2f4338"/>
  <rect x="148" y="248" width="66" height="52" rx="6" fill="#4a6354"/>
  <rect x="298" y="248" width="66" height="52" rx="6" fill="#4a6354"/>
  <rect x="148" y="158" width="28" height="50" rx="4" fill="#4a6354"/>
  <rect x="196" y="148" width="28" height="60" rx="4" fill="#4a6354"/>
  <rect x="244" y="140" width="28" height="68" rx="4" fill="#4a6354"/>
  <rect x="292" y="148" width="28" height="60" rx="4" fill="#4a6354"/>
  <rect x="340" y="158" width="28" height="50" rx="4" fill="#4a6354"/>
</svg>`;

sharp(Buffer.from(svg))
  .resize(512, 512)
  .png()
  .toFile(path.join(__dirname, '..', 'assets', 'icon.png'))
  .then(() => console.log('assets/icon.png created (512x512)'))
  .catch(err => console.error('sharp SVG error:', err.message));
