// One-off: repair mojibake introduced by shell writes. Run once.
import fs from 'node:fs';

const files = [
  'src/services/seed.mjs',
  'src/views/checkout/address.ejs',
];
for (const f of files) {
  let text = fs.readFileSync(f, 'utf8');
  const before = text;
  // Common mojibake sequences -> intended characters
  text = text
    .replaceAll('â€”', '—')
    .replaceAll('â€“', '–')
    .replaceAll('â€"', '—')
    .replaceAll('\uFFFD-', '×')
    .replaceAll('\uFFFD', '');
  if (text !== before) {
    fs.writeFileSync(f, text, 'utf8');
    console.log('fixed', f);
  } else {
    console.log('clean ', f);
  }
}
