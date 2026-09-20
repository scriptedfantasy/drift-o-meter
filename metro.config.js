// Metro config. The Expo defaults already cover everything this app needs:
//  - Skia on web: CanvasKit's canvaskit.js is bundled by Metro; the .wasm is fetched at runtime
//    from /canvaskit.wasm (copied into public/ by scripts/copy-canvaskit.mjs). Node built-ins that
//    canvaskit.js references (`fs`, `path`) are shimmed to empty modules by @expo/cli on web.
//  - Reanimated / worklets: babel-preset-expo adds react-native-worklets/plugin automatically.
// Keep this file: later agents can hook resolver/transformer tweaks here without guessing.
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

module.exports = config;
