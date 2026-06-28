const sharp = require('sharp');
const pngToIco = require('png-to-ico').default;
const fs = require('fs');
const path = require('path');

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <!-- Navy background with rounded corners -->
  <rect width="256" height="256" rx="52" fill="#0f1923"/>

  <!-- Briefcase handle -->
  <path d="M94 106 L94 86 Q94 68 112 68 L144 68 Q162 68 162 86 L162 106"
        stroke="#5b9bd5" stroke-width="14" fill="none"
        stroke-linecap="round" stroke-linejoin="round"/>

  <!-- Briefcase body depth -->
  <rect x="46" y="106" width="164" height="108" rx="14" fill="#2a4a6a"/>

  <!-- Briefcase body -->
  <rect x="46" y="106" width="164" height="104" rx="14" fill="#5b9bd5"/>

  <!-- Horizontal divider -->
  <rect x="46" y="152" width="164" height="8" fill="#0f1923" opacity="0.2"/>

  <!-- Center clasp plate -->
  <rect x="108" y="143" width="40" height="26" rx="6" fill="#0f1923" opacity="0.35"/>

  <!-- Clasp inner highlight -->
  <rect x="116" y="150" width="24" height="12" rx="3" fill="#88bce8"/>

  <!-- Subtle shine -->
  <rect x="46" y="106" width="164" height="30" rx="14" fill="white" opacity="0.07"/>
</svg>`;

async function generate() {
  const dir     = path.join(__dirname);
  const pngPath = path.join(dir, 'icon.png');
  const icoPath = path.join(dir, 'icon.ico');

  await sharp(Buffer.from(svg)).resize(256, 256).png().toFile(pngPath);
  console.log('icon.png generated');

  const icoBuf = await pngToIco(pngPath);
  fs.writeFileSync(icoPath, icoBuf);
  console.log('icon.ico generated');
}

generate().catch(e => { console.error(e); process.exit(1); });
