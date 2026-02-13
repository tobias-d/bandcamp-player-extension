// webpack.config.js
const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = {
  devtool: 'source-map',
  entry: {
    'content-scripts/bandcamp-player': './src/content-scripts/bandcamp-player.js',
    'ui/results-panel': './src/ui/results-panel.js',
    background: './src/background/index.js', // changed
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
  },
  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: { loader: 'babel-loader', options: { presets: ['@babel/preset-env'] } },
      },
    ],
  },
  plugins: [
    new CopyPlugin({
      patterns: [{ from: 'src/manifest.json', to: 'manifest.json' }],
    }),
  ],
};
