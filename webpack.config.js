const path = require('path');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const { CleanWebpackPlugin } = require('clean-webpack-plugin');

module.exports = (env = {}, argv = {}) => {
  // Browser target controls which manifest is copied into dist/manifest.json.
  // Supported values: "firefox" | "chrome". Defaults to firefox.
  const target = (env.target || process.env.BROWSER || 'firefox').toLowerCase();
  const manifestSource = target === 'chrome' ? 'src/manifest.json' : 'src/manifest.firefox.json';

  return {
    mode: argv.mode || 'production',
    entry: {
      background: './src/background/index.ts',
      'content-scripts/bandcamp-player': './src/content-scripts/bandcamp-player.ts',
    },
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: '[name].js',
      clean: true,
      globalObject: 'self',
      environment: {
        globalThis: true,
      },
    },
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          use: {
            loader: 'ts-loader',
            options: {
              compilerOptions: {
                noEmit: false,
              },
            },
          },
          exclude: /node_modules/,
        },
        {
          test: /\.js$/,
          exclude: /node_modules/,
          use: {
            loader: 'babel-loader',
            options: {
              presets: ['@babel/preset-env'],
            },
          },
        },
      ],
    },
    resolve: {
      extensions: ['.tsx', '.ts', '.js'],
      fallback: {
        crypto: false,
        path: false,
        fs: false,
        stream: false,
        util: false,
        assert: false,
        buffer: require.resolve('buffer/'),
        process: require.resolve('process/browser'),
      },
    },
    plugins: [
      new CleanWebpackPlugin(),
      new CopyWebpackPlugin({
        patterns: [
          { from: 'src/public', to: 'public', noErrorOnMissing: true },
          // Prefer root-level public/ for assets if present during release prep.
          { from: 'public', to: 'public', noErrorOnMissing: true },
          { from: manifestSource, to: 'manifest.json' },
          {
            from: 'node_modules/essentia.js/dist/essentia-wasm.web.wasm',
            to: 'essentia-wasm.wasm',
          },
        ],
      }),
    ],
    devtool: 'source-map',
    target: 'web',
    performance: {
      hints: 'warning',
      maxAssetSize: 3 * 1024 * 1024,
      maxEntrypointSize: 3 * 1024 * 1024,
      assetFilter: (assetFilename) => !assetFilename.endsWith('.map'),
    },
    experiments: {
      asyncWebAssembly: true,
    },
  };
};
