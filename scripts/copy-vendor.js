const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const publicVendor = path.join(rootDir, 'public', 'vendor');

const vendorFiles = [
  { src: 'node_modules/d3/dist/d3.min.js', dest: 'd3/d3.min.js' },
  { src: 'node_modules/quill/dist/quill.js', dest: 'quill/quill.js' },
  { src: 'node_modules/quill/dist/quill.snow.css', dest: 'quill/quill.snow.css' },
  { src: 'node_modules/glightbox/dist/css/glightbox.min.css', dest: 'glightbox/css/glightbox.min.css' },
  { src: 'node_modules/glightbox/dist/js/glightbox.min.js', dest: 'glightbox/js/glightbox.min.js' },
  { src: 'node_modules/html2canvas/dist/html2canvas.min.js', dest: 'html2canvas/html2canvas.min.js' }
];

for (const { src, dest } of vendorFiles) {
  const destPath = path.join(publicVendor, dest);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(path.join(rootDir, src), destPath);
  console.log(`Copied: ${src} -> public/vendor/${dest}`);
}

console.log('Vendor files copied.');
