import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  // Tell Vite that all your source files (including index.html) live in the 'site' folder
  root: './site', 
  plugins: [
    viteSingleFile()
  ],
  build: {
    // Output the final built file into a 'dist' folder at the project root (outside 'site')
    outDir: '../dist', 
    emptyOutDir: true
  }
});
