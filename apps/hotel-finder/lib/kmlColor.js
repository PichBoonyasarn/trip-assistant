// Converts this app's `RRGGBB` hex color convention (lib/mapColors.js) to
// KML's `aabbggrr` order — KML colors are alpha + blue + green + red, the
// reverse byte order of the usual web RRGGBB. Easy to get backwards, so this
// is the one place that conversion happens.
//
// Known conversions (manual check, since this app has no test suite):
//   rgbHexToKmlColor('FF0000') -> 'ff0000ff'  (hotel red: alpha ff, blue 00, green 00, red ff)
//   rgbHexToKmlColor('0000FF') -> 'ffff0000'  (worksite blue: alpha ff, blue ff, green 00, red 00)
function rgbHexToKmlColor(rrggbb, alpha = 'ff') {
  const hex = rrggbb.replace(/^#/, '');
  const r = hex.slice(0, 2);
  const g = hex.slice(2, 4);
  const b = hex.slice(4, 6);
  return `${alpha}${b}${g}${r}`.toLowerCase();
}

module.exports = { rgbHexToKmlColor };
