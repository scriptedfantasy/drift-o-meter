// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    /**
     * `dist/**`, not Expo's generated `dist/*`.
     *
     * A flat-config `dist/*` ignores only what sits DIRECTLY in dist, and the web export puts
     * its bundles at `dist/_expo/static/js/web/`. So `npx eslint .` walked a 3.6 MB generated
     * bundle and reported 111,000 problems — 44,236 of them `no-var` — while `expo lint`
     * reported 138, because it passes its own globs. Two commands, the same config, three
     * orders of magnitude apart, and the alarming number is the one about code nobody wrote.
     */
    ignores: ['dist/**', 'artifacts/**'],
  },
]);
